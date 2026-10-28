import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ExecMode, StatsMode, QueryServiceDefinition } from '@ydbjs/api/query';
import { compileHarnessFromContract } from '../unit/harness.ts';
import { createFixture, quote } from './helpers.ts';

test('relation includes read indexed children through VIEW lookups', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      [
        '// use prisma-8',
        'model Parent {',
        '  id String @id',
        '  name String',
        '  children Child[]',
        `  @@map("${table('Parent')}")`,
        '}',
        'model Child {',
        '  id String @id',
        '  parentId String',
        '  label String',
        '  parent Parent @relation(fields: [parentId], references: [id], index: false)',
        '  @@index([parentId], map: "child_parent")',
        `  @@map("${table('Child')}")`,
        '}',
      ].join('\n'),
  });
  const { db, native } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Parent'))} (id Utf8 NOT NULL, name Utf8 NOT NULL, PRIMARY KEY (id));`,
  );
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Child'))} (id Utf8 NOT NULL, parentId Utf8 NOT NULL, label Utf8 NOT NULL, PRIMARY KEY (id), INDEX child_parent GLOBAL SYNC ON (parentId));`,
  );
  for (const id of ['p1', 'p2', 'p3'])
    await db.orm.Parent.create({ id, name: id === 'p3' ? 'other' : 'group' });
  await db.orm.Child.create({ id: 'c1', parentId: 'p1', label: 'one' });
  await db.orm.Child.create({ id: 'c2', parentId: 'p1', label: 'two' });
  await db.orm.Child.create({ id: 'c3', parentId: 'p3', label: 'three' });

  const parents = await db.orm.Parent.where({ name: 'group' })
    .include('children', (children) => children.select('id', 'label'))
    .all();
  const byId = new Map(parents.map((parent) => [parent.id, parent]));
  assert.deepEqual(
    byId
      .get('p1')
      ?.children.map((child) => child.id)
      .sort(),
    ['c1', 'c2'],
  );
  assert.deepEqual(byId.get('p2')?.children, []);
  assert.equal(byId.has('p3'), false);

  // The compiled statement itself must plan as an index lookup, not a child scan.
  const harness = compileHarnessFromContract(fixture.contractJson);
  const Parent = harness.models['Parent'] as {
    where(filter: unknown): {
      include(
        name: string,
        select: (rows: { select(...fields: string[]): unknown }) => unknown,
      ): { all(): Promise<unknown> };
    };
  };
  const sql = await harness.sql(() =>
    Parent.where({ name: 'group' })
      .include('children', (children) => children.select('id', 'label'))
      .all(),
  );
  assert.match(sql, /VIEW `child_parent`/);
  const client = native.core.createClient(QueryServiceDefinition);
  const session = await client.createSession({});
  const attach = client
    .attachSession({ sessionId: session.sessionId })
    [Symbol.asyncIterator]();
  await attach.next();
  try {
    let plan = '';
    for await (const part of client.executeQuery({
      sessionId: session.sessionId,
      execMode: ExecMode.EXPLAIN,
      statsMode: StatsMode.FULL,
      query: { case: 'queryContent', value: { text: sql, syntax: 1 } },
    }))
      plan += part.execStats?.queryPlan ?? '';
    assert.match(plan, /child_parent/);
    assert.match(plan, /TableLookup/);
  } finally {
    await attach.return?.();
    await client.deleteSession({ sessionId: session.sessionId });
  }
});
