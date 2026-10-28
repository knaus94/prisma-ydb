import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SqlQueryError } from '@prisma/orm-family-sql/errors';
import { createFixture } from './helpers.ts';

test(
  'column-store models migrate, verify and mutate without RETURNING',
  { timeout: 120_000 },
  async (context) => {
    const fixture = await createFixture(context, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Event {',
          '  tenant Int',
          '  id String',
          '  kind String',
          '  value Float?',
          '  at DateTime',
          '  @@id([tenant, id])',
          '  @@columnStore(minPartitions: 2)',
          `  @@map("${table('Event')}")`,
          '}',
          'model Note {',
          '  id String @id',
          '  text String',
          `  @@map("${table('Note')}")`,
          '}',
        ].join('\n'),
    });
    const { db } = fixture;
    const output = (result: { stdout: string; stderr: string }) =>
      result.stdout + result.stderr;
    const planned = await fixture.prisma([
      'migration',
      'plan',
      '--from',
      '@empty',
      '--name',
      'initial',
    ]);
    assert.equal(planned.code, 0, planned.stdout + planned.stderr);
    const migrated = await fixture.prisma(['db', 'migrate']);
    assert.equal(migrated.code, 0, output(migrated));
    const verified = await fixture.prisma(['db', 'verify']);
    assert.equal(verified.code, 0, output(verified));
    const kind = await fixture.native.executeYql({
      text: 'SELECT 1',
      transactionMode: 'snapshotReadOnly',
    });
    assert.equal(kind.resultSets[0]?.rows.length, 1);

    const at = new Date('2026-03-04T05:06:07.000Z');
    const created = await db.orm.Event.create({
      tenant: 1,
      id: 'e1',
      kind: 'click',
      value: null,
      at,
    });
    assert.deepEqual(created, {
      tenant: 1,
      id: 'e1',
      kind: 'click',
      value: null,
      at,
    });
    await assert.rejects(
      db.orm.Event.create({
        tenant: 1,
        id: 'e1',
        kind: 'dup',
        value: null,
        at,
      }),
      (error: unknown) =>
        error instanceof SqlQueryError && error.sqlState === '23505',
    );
    await db.orm.Event.create({
      tenant: 1,
      id: 'e2',
      kind: 'view',
      value: 2.5,
      at,
    });
    const updated = await db.orm.Event.where({ tenant: 1 }).updateAll({
      kind: 'seen',
    });
    assert.equal(updated.length, 2);
    assert.deepEqual(updated.map((row) => row.id).sort(), ['e1', 'e2']);
    const one = await db.orm.Event.where({ tenant: 1, id: 'e1' }).update({
      value: 1.5,
    });
    assert.equal(one?.value, 1.5);
    const deleted = await db.orm.Event.where({ tenant: 1, id: 'e2' }).delete();
    assert.equal(deleted?.kind, 'seen');
    assert.deepEqual(
      (await db.orm.Event.where({ tenant: 1 }).all()).map((row) => row.id),
      ['e1'],
    );
    assert.equal(await db.orm.Event.where({ tenant: 1 }).deleteAndCount(), 1);
    assert.equal((await db.orm.Event.all()).length, 0);

    await db.bulkUpsert(
      'Event',
      Array.from({ length: 50 }, (_, index) => ({
        tenant: 2,
        id: `b${index}`,
        kind: 'bulk',
        at,
      })),
    );
    const bulk = await db.orm.Event.where({ tenant: 2 }).aggregate((a) => ({
      total: a.count(),
    }));
    assert.equal(bulk.total, 50);

    // Row and column tables never share one write transaction.
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.orm.Note.create({ id: 'n', text: 't' });
        await tx.orm.Event.create({
          tenant: 3,
          id: 'x',
          kind: 'k',
          value: null,
          at,
        });
      }),
    );

    const inferred = await fixture.prisma([
      'contract',
      'infer',
      '--output',
      'inferred.prisma',
    ]);
    assert.equal(inferred.code, 0, output(inferred));
    const psl = await readFile(join(fixture.cwd, 'inferred.prisma'), 'utf8');
    assert.match(psl, /@@columnStore/);
  },
);

test('column-store contracts reject row-only features', async (context) => {
  await assert.rejects(
    createFixture(context, {
      schema: (table) =>
        [
          '// use prisma-8',
          'model Bad {',
          '  id String @id',
          '  n Int',
          '  @@index([n])',
          '  @@columnStore',
          `  @@map("${table('Bad')}")`,
          '}',
        ].join('\n'),
    }),
    /column-store table .* does not support @@index/,
  );
});
