import assert from 'node:assert/strict';
import { test } from 'node:test';
import { yqlModel, TimestampMicrosValue } from 'prisma-ydb/runtime';
import { createFixture, quote } from './helpers.ts';

test('bulkUpsert encodes model rows through the contract codecs', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      [
        '// use prisma-8',
        'model Item {',
        '  id String @id',
        '  n Int',
        '  big BigInt?',
        '  tags String[]',
        '  at DateTime',
        '  amount Decimal(12, 2)?',
        `  @@map("${table('Item')}")`,
        '}',
      ].join('\n'),
  });
  const { db } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Item'))} (id Utf8 NOT NULL, n Int32 NOT NULL, big Int64, tags Json NOT NULL, at Timestamp NOT NULL, amount Decimal(12,2), PRIMARY KEY (id));`,
  );
  const at = new Date('2026-01-02T03:04:05.000Z');
  const rows = Array.from({ length: 2500 }, (_, index) => ({
    id: `item-${String(index).padStart(5, '0')}`,
    n: index,
    tags: index % 2 ? ['odd', `t${index}`] : [],
    at,
    ...(index % 3 ? { amount: `${index}.25` } : {}),
    ...(index % 5 ? {} : { big: BigInt(index) * 1_000_000_000n }),
  }));
  const before = db.stats().paths.bulkUpsert;
  const upload = db.bulkUpsert('Item', rows, { chunkSize: 1000 });
  const result = await upload;
  const after = db.stats().paths.bulkUpsert;
  assert.equal(after.total - before.total, 3);
  assert.equal(after.errors, before.errors);
  assert.equal(after.active, 0);
  assert.deepEqual(result, { rows: 2500, chunks: 3 });

  const count = await db.orm.Item.aggregate((aggregate) => ({
    total: aggregate.count(),
  }));
  assert.equal(count.total, 2500);
  const sample = await db.orm.Item.where({ id: 'item-00007' }).first();
  assert.deepEqual(sample, {
    id: 'item-00007',
    n: 7,
    big: null,
    tags: ['odd', 't7'],
    at,
    amount: '7.25',
  });
  const zero = await db.orm.Item.where({ id: 'item-00000' }).first();
  assert.equal(zero?.big, 0n);
  assert.equal(zero?.amount, null);
  assert.deepEqual(zero?.tags, []);

  // Upserting again touches only the fields the upload carries.
  await db.bulkUpsert('Item', [{ id: 'item-00007', n: 70, tags: [], at }]);
  const updated = await db.orm.Item.where({ id: 'item-00007' }).first();
  assert.equal(updated?.n, 70);
  assert.equal(
    updated?.amount,
    '7.25',
    'fields absent from every row stay untouched',
  );
  // A field present in any row is part of the upload: explicit null clears it.
  await db.bulkUpsert('Item', [
    { id: 'item-00007', n: 71, tags: [], at, amount: null },
    { id: 'item-00008', n: 81, tags: [], at },
  ]);
  assert.equal(
    (await db.orm.Item.where({ id: 'item-00007' }).first())?.amount,
    null,
  );
  assert.equal(
    (await db.orm.Item.where({ id: 'item-00008' }).first())?.amount,
    null,
  );

  await assert.rejects(
    db.bulkUpsert('Item', [{ id: 'x', n: 1, tags: [], at, extra: 1 }]),
    /Unknown field extra/,
  );
  await assert.rejects(
    db.bulkUpsert('Item', [{ n: 1, tags: [], at }]),
    /lacks primary key field id/,
  );
  await assert.rejects(
    db.bulkUpsert('Item', [{ id: 'x', n: 'one', tags: [], at }]),
    /Row 0: Expected a finite number/,
  );
  assert.deepEqual(await db.bulkUpsert('Item', []), { rows: 0, chunks: 0 });
  const micros = 1_767_323_045_123_456n;
  await db.bulkUpsert('Item', [
    { id: 'exact-a', n: 1, tags: [], at: micros },
    {
      id: 'exact-b',
      n: 2,
      tags: [],
      at: new TimestampMicrosValue(micros + 1n),
    },
  ]);
  const clock = yqlModel(db.contract, 'Item', {
    fields: ['id', 'at'],
    micros: ['at'],
  });
  assert.deepEqual(
    clock.decodeAll(
      await db.yql(
        `SELECT id, at FROM ${clock.table} WHERE id IN ('exact-a', 'exact-b') ORDER BY id;`,
      ),
    ),
    [
      { id: 'exact-a', at: micros },
      { id: 'exact-b', at: micros + 1n },
    ],
  );
});
