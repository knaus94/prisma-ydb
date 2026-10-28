import assert from 'node:assert/strict';
import { test } from 'node:test';
import { yqlModel } from 'prisma-ydb/runtime';
import { compileHarness } from './harness.ts';

test('yqlModel derives native types and codec round trips from mapped fields', async (context) => {
  const { contract } = await compileHarness(
    context,
    [
      '// use prisma-8',
      'model Item {',
      '  id String @id @map("item_id")',
      '  big BigInt',
      '  at DateTime',
      '  exact Timestamp',
      '  day Date',
      '  amount Decimal(12, 2)?',
      '  tags BigInt[]',
      '  data Json',
      '  @@map("items")',
      '}',
    ].join('\n'),
  );
  const item = yqlModel(contract, 'Item');
  assert.equal(item.table, '`items`');
  assert.equal(
    item.columns.find((column) => column.field === 'id')?.column,
    'item_id',
  );
  assert.equal(
    item.columns.find((column) => column.field === 'amount')?.yqlType,
    'Decimal(12,2)?',
  );
  assert.equal(
    item.columns.find((column) => column.field === 'tags')?.yqlType,
    'Json',
  );
  assert.equal(item.listType, `List<${item.structType}>`);
  assert.equal(
    item.declare('rows', 'list'),
    `DECLARE $rows AS ${item.listType};`,
  );
  assert.equal(
    item.declare('$row', 'struct'),
    `DECLARE $row AS ${item.structType};`,
  );

  const row = {
    id: 'one',
    big: 9_007_199_254_740_993n,
    at: new Date('2026-01-02T03:04:05.123Z'),
    exact: '2026-01-02T03:04:05.123456Z',
    day: '2026-01-02',
    amount: '12.50',
    tags: [9_007_199_254_740_993n],
    data: { label: 'hello', values: [1, true, null] },
  };
  const struct = item.row(row);
  assert.ok('value' in struct);
  assert.equal(struct.type.type.case, 'structType');
  const list = item.rows([row]);
  assert.ok('value' in list);
  assert.equal(list.type.type.case, 'listType');
  assert.equal(list.value.items.length, 1);
  assert.deepEqual(list.value.items[0], struct.value);
  const empty = item.rows([]);
  assert.ok('value' in empty);
  assert.deepEqual(empty.type, list.type);
  assert.deepEqual(empty.value.items, []);

  const native = {
    item_id: row.id,
    big: row.big,
    at: 1_767_323_045_123_456n,
    exact: 1_767_323_045_123_456n,
    day: new Date('2026-01-02T00:00:00.000Z'),
    amount: '12.50',
    tags: ['9007199254740993'],
    data: row.data,
  };
  assert.deepEqual(item.decode(native), row);
  assert.deepEqual(item.decodeAll([native]), [row]);
  assert.deepEqual(
    item.decodeAll({
      resultSets: [{ index: 0, columns: [], rows: [native] }],
      affectedRows: 0,
    }),
    [row],
  );

  const projected = yqlModel(contract, 'Item', { fields: ['id', 'amount'] });
  const omitted = projected.row({ id: 'two' });
  const explicit = projected.row({ id: 'two', amount: null });
  assert.deepEqual(omitted, explicit);
  assert.deepEqual(
    projected.decode({ item_id: 'two', amount: null, other: true }),
    {
      id: 'two',
      amount: null,
    },
  );
  assert.throws(() => projected.row({ id: 'x', big: 1n }), /Unknown field big/);
  assert.throws(() => projected.row({ amount: null }), /id is required/);
  assert.throws(
    () => projected.decode({ item_id: 'x' }),
    /Missing YDB column amount/,
  );
  assert.throws(
    () => item.declare('x; SELECT 1', 'list'),
    /Invalid YDB parameter name/,
  );
  assert.throws(
    () => yqlModel(contract, 'Item', { fields: ['unknown'] }),
    /Unknown field/,
  );
  assert.throws(
    () => yqlModel(contract, 'Item', { fields: ['id', 'id'] }),
    /unique/,
  );
  assert.throws(
    () => yqlModel(contract, 'Item', { fields: [] }),
    /at least one/,
  );
});
