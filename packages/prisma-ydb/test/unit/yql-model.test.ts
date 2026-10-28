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

test('YQL descriptors encode exact clocks, safe integers and value-free containers', async (context) => {
  const {
    ydbDecimal,
    ydbTimestamp,
    ydbInt64,
    ydbUint64,
    ydbNumber,
    ydbUuid,
    ydbInt32,
    optional,
    list,
    struct,
    TimestampMicrosValue,
  } = await import('prisma-ydb/runtime');
  const decimal = ydbDecimal.with(12, 2);
  assert.equal(decimal.yqlType, 'Decimal(12,2)');
  assert.equal(decimal.wireType(), decimal.wireType());
  assert.equal(ydbDecimal.wireType(), ydbDecimal.wireType());
  assert.equal(decimal.wireType().type.case, 'decimalType');
  assert.deepEqual(
    decimal.wire('12.5').encode(),
    decimal.nativeConversions().encode('12.50'),
  );
  assert.equal(decimal.nativeConversions().decode('12.50'), '12.50');
  const nullable = optional(ydbUuid);
  const nil = nullable.wire(null);
  assert.ok('value' in nil);
  assert.equal(nil.type, nullable.wireType());
  assert.equal(nil.value.value.case, 'nullFlagValue');
  const uuid = '00112233-4455-6677-8899-aabbccddeeff';
  const present = nullable.wire(uuid);
  assert.ok('value' in present);
  assert.deepEqual(present.value, ydbUuid.wire(uuid).encode());
  const nested = optional(nullable).wire(uuid);
  assert.ok('value' in nested);
  assert.equal(nested.value.value.case, 'nestedValue');

  const shape = struct({ amount: decimal, owner: nullable });
  const empty = list(shape).wire([]);
  assert.ok('value' in empty);
  assert.equal(empty.type.type.case, 'listType');
  assert.deepEqual(empty.value.items, []);
  assert.deepEqual(
    shape.nativeConversions().decode({ amount: '1.25', owner: null }),
    { amount: '1.25', owner: null },
  );
  for (const descriptor of [ydbInt64, ydbUint64, ydbNumber]) {
    assert.deepEqual(
      descriptor.nativeConversions().encode(42),
      descriptor.nativeConversions().encode(42n),
    );
    assert.throws(
      () => descriptor.wire(Number.MAX_SAFE_INTEGER + 1),
      /safe|MAX_SAFE/,
    );
  }
  const micros = 1_767_323_045_123_456n;
  const millis = micros - (micros % 1000n);
  const date = new Date(Number(millis / 1000n));
  const timestamp = ydbTimestamp.nativeConversions();
  assert.equal(timestamp.encodeJson(date), date.toISOString());
  assert.equal(timestamp.encodeJson(millis), date.toISOString());
  assert.equal(
    timestamp.encodeJson(new TimestampMicrosValue(millis)),
    date.toISOString(),
  );
  assert.equal(timestamp.encodeJson(micros), '2026-01-02T03:04:05.123456Z');

  assert.deepEqual(
    ydbTimestamp.wire(micros).encode(),
    new TimestampMicrosValue(micros).encode(),
  );
  assert.deepEqual(
    ydbTimestamp.nativeConversions().encode(new TimestampMicrosValue(micros)),
    ydbTimestamp.wire(micros).encode(),
  );
  assert.deepEqual(
    await ydbTimestamp.factory()().decode(micros),
    new Date('2026-01-02T03:04:05.123Z'),
  );
  assert.deepEqual(
    (await ydbTimestamp.factory()().encode(micros)).encode(),
    ydbTimestamp.wire(micros).encode(),
  );
  assert.throws(() => ydbTimestamp.wire(-1n), /range/);
  assert.throws(() => ydbTimestamp.wire(4291747200000000n), /range/);
  const { contract } = await compileHarness(
    context,
    '// use prisma-8\nmodel Item {\n id String @id @map("item_id")\n at DateTime\n}',
  );
  const model = yqlModel(contract, 'Item', {
    micros: ['at'],
    extra: { owner: ydbInt32 },
  });
  const encoded = model.row({ id: 'one', at: micros, owner: 7 });
  assert.ok('value' in encoded);
  assert.equal(encoded.type, model.wireType());
  assert.equal(
    encoded.value.items[
      model.columns.findIndex((column) => column.field === 'at')
    ].value.case,
    'uint64Value',
  );
  assert.deepEqual(model.decode({ item_id: 'one', at: micros, owner: 7 }), {
    id: 'one',
    at: micros,
    owner: 7,
  });
  assert.throws(
    () => yqlModel(contract, 'Item', { extra: { item_id: ydbInt32 } }),
    /collides/,
  );
  assert.throws(
    () => yqlModel(contract, 'Item', { extra: { 'bad-name': ydbInt32 } }),
    /Invalid/,
  );
  assert.throws(
    () => yqlModel(contract, 'Item', { micros: ['id'] }),
    /Timestamp field/,
  );
});
