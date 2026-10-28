import assert from 'node:assert/strict';
import { test } from 'node:test';
import { yqlModel } from 'prisma-ydb/runtime';
import { createFixture, quote } from './helpers.ts';

test('yqlModel writes typed native rows and decodes them like ORM rows', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      [
        '// use prisma-8',
        'model Item {',
        '  id String @id @map("item_id")',
        '  n Int',
        '  big BigInt?',
        '  tags BigInt[]',
        '  at DateTime',
        '  exact Timestamp',
        '  day Date',
        '  data Json',
        '  amount Decimal(12, 2)?',
        `  @@map("${table('Item')}")`,
        '}',
      ].join('\n'),
  });
  const { db } = fixture;
  await fixture.ddl(
    `CREATE TABLE ${quote(fixture.table('Item'))} (item_id Utf8 NOT NULL, n Int32 NOT NULL, big Int64, tags Json NOT NULL, at Timestamp NOT NULL, exact Timestamp NOT NULL, day Date NOT NULL, data Json NOT NULL, amount Decimal(12,2), PRIMARY KEY (item_id));`,
  );
  const item = yqlModel(db.contract, 'Item');
  const rows = [
    {
      id: 'first',
      n: 1,
      big: 9_007_199_254_740_993n,
      tags: [9_007_199_254_740_993n],
      at: new Date('2026-01-02T03:04:05.123Z'),
      exact: '2026-01-02T03:04:05.123456Z',
      day: '2026-01-02',
      data: { label: 'hello', list: [1, null] },
      amount: '1234.50',
    },
    {
      id: 'second',
      n: 2,
      big: null,
      tags: [],
      at: new Date('2026-01-02T03:04:05.000Z'),
      exact: '2026-01-02T03:04:05.000001Z',
      day: '2026-01-02',
      data: ['x', false],
      amount: null,
    },
  ];
  await db.yql(
    `${item.declare('rows', 'list')} UPSERT INTO ${item.table} SELECT * FROM AS_TABLE($rows);`,
    { rows: item.rows(rows) },
  );
  const result = await db.queryYql({
    text: `SELECT * FROM ${item.table} ORDER BY item_id;`,
  });
  assert.deepEqual(item.decodeAll(result), rows);
  assert.deepEqual(
    await db.orm.Item.orderBy((field) => field.id.asc()).all(),
    rows,
  );
  const projection = db.yqlModel('Item', { fields: ['id', 'n'] });
  await db.yql(
    `${projection.declare('row', 'struct')} UPDATE ${projection.table} ON SELECT * FROM AS_TABLE(AsList($row));`,
    { row: projection.row({ id: 'first', n: 42 }) },
  );
  assert.deepEqual(
    projection.decodeAll(
      await db.yql(
        `SELECT item_id, n FROM ${projection.table} ORDER BY item_id;`,
      ),
    ),
    [
      { id: 'first', n: 42 },
      { id: 'second', n: 2 },
    ],
  );
});
