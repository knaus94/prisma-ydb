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

test('ORM index reads, bounded descending scans and composite key lists use keyed paths', async (context) => {
  const { ydbView, whereKeys } = await import('prisma-ydb/runtime');
  const fixture = await createFixture(context, {
    schema: (table) =>
      [
        '// use prisma-8',
        'model Wallet {',
        '  userKey Uint64',
        '  userId String',
        '  kind Int',
        '  owner String',
        '  seq Int',
        '  status String',
        '  @@id([userKey, userId, kind])',
        '  @@index([owner, seq], map: "wallet_history")',
        `  @@map("${table('Wallet')}")`,
        '}',
      ].join('\n'),
  });
  const { db, native } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Wallet'))} (userKey Uint64 NOT NULL, userId Utf8 NOT NULL, kind Int32 NOT NULL, owner Utf8 NOT NULL, seq Int32 NOT NULL, status Utf8 NOT NULL, PRIMARY KEY (userKey, userId, kind), INDEX wallet_history GLOBAL SYNC ON (owner, seq));`,
  );
  const userKey = 3198191471355371895n;
  for (let seq = 1; seq <= 5; seq++)
    await db.orm.Wallet.create({
      userKey,
      userId: `u${seq}`,
      kind: 1,
      owner: 'alice',
      seq,
      status: seq === 2 ? 'settled' : 'pending',
    });
  const rows = await db.orm.Wallet.where({ owner: 'alice' })
    .orderBy((row) => row.seq.desc())
    .all((meta) => meta.annotate(ydbView('wallet_history')));
  assert.deepEqual(
    rows.map((row) => row.seq),
    [5, 4, 3, 2, 1],
  );
  const prepared = await db.prepare({ owner: 'ydb/utf8@1' }, (params) =>
    db.orm.Wallet.where((row) => row.owner.eq(params.owner)).prepared.all(
      (meta) => meta.annotate(ydbView('wallet_history')),
    ),
  );
  assert.equal((await prepared.query(db, { owner: 'alice' })).length, 5);
  const first = await db.scanIndex('Wallet', {
    index: 'wallet_history',
    equal: { owner: 'alice' },
    direction: 'desc',
    budget: 2,
    select: ['userId', 'seq', 'status'],
    accept: (row) => row.status === 'settled',
  });
  assert.deepEqual(first.rows, []);
  assert.equal(first.inspected, 2);
  assert.deepEqual(first.lastKey, { seq: 4, userKey, userId: 'u4', kind: 1 });
  assert.equal(first.exhausted, false);
  const second = await db.transaction(
    (tx) =>
      tx.scanIndex('Wallet', {
        index: 'wallet_history',
        equal: { owner: 'alice' },
        direction: 'desc',
        after: first.lastKey,
        budget: 2,
        select: ['userId', 'seq', 'status'],
        accept: (row) => row.status === 'settled',
      }),
    { mode: 'snapshotReadOnly' },
  );
  assert.deepEqual(second.rows, [{ userId: 'u2', seq: 2, status: 'settled' }]);
  assert.equal(second.inspected, 2);
  assert.equal(second.lastKey?.userId, 'u2');
  const tail = await db.scanIndex('Wallet', {
    index: 'wallet_history',
    equal: { owner: 'alice' },
    direction: 'desc',
    after: second.lastKey,
    budget: 2,
    select: ['userId'],
  });
  assert.deepEqual(tail.rows, [{ userId: 'u1' }]);
  assert.equal(tail.inspected, 1);
  assert.equal(tail.exhausted, true);
  await assert.rejects(
    db.scanIndex('Wallet', {
      index: 'wallet_history',
      equal: { seq: 1 },
      budget: 1,
    }),
    /leading index prefix/,
  );
  const keyed = await db.orm.Wallet.where((row) =>
    whereKeys(row, [
      { userKey, userId: 'u2', kind: 1 },
      { userKey, userId: 'u4', kind: 1 },
    ]),
  ).all();
  assert.deepEqual(keyed.map((row) => row.userId).sort(), ['u2', 'u4']);
  assert.deepEqual(
    await db.orm.Wallet.where((row) => whereKeys(row, [])).all(),
    [],
  );

  await db.orm.Wallet.where((row) =>
    whereKeys(row, [{ userKey, userId: 'u4', kind: 1 }]),
  ).update({ status: 'looked-up' });
  assert.equal(
    (await db.orm.Wallet.where({ userKey, userId: 'u4', kind: 1 }).first())
      ?.status,
    'looked-up',
  );
  await db.orm.Wallet.where((row) =>
    whereKeys(row, [{ userKey, userId: 'u1', kind: 1 }]),
  ).delete();
  assert.equal(
    await db.orm.Wallet.where({ userKey, userId: 'u1', kind: 1 }).first(),
    null,
  );

  const harness = compileHarnessFromContract(fixture.contractJson);
  type Read = {
    where(filter: unknown): Read;
    all(
      configure?: (
        meta: import('@prisma/orm-framework/components/runtime').MetaBuilder<'read'>,
      ) => void,
    ): Promise<unknown>;
  };
  const Wallet = harness.models['Wallet'] as Read;
  const sql = await harness.sql(() =>
    Wallet.where({ owner: 'alice', seq: 2 }).all((meta) =>
      meta.annotate(ydbView('wallet_history')),
    ),
  );
  assert.match(sql, /VIEW `wallet_history`/);
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
    assert.match(plan, /wallet_history/);
    assert.match(plan, /TableLookup|TableRangeScan/);
  } finally {
    await attach.return?.();
    await client.deleteSession({ sessionId: session.sessionId });
  }
});
