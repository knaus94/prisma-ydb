import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  yqlStatement,
  yqlModel,
  ydbContract,
  ydbInt64,
  ydbUuid,
  ydbInt32,
  optional,
  list,
  struct,
  columns,
} from 'prisma-ydb/runtime';
import { ydbContractSerializer } from 'prisma-ydb/control';
import { compileHarness } from './harness.ts';

test('typed YQL generates declarations, encodes null/empty values and decodes named sets', async (context) => {
  const { contract } = await compileHarness(
    context,
    '// use prisma-8\nmodel Item {\n id String @id @map("item_id")\n n Int\n}',
  );
  const hydrated = ydbContract(
    ydbContractSerializer.serializeContract(contract),
  );
  assert.equal(hydrated.target, 'ydb');
  const model = yqlModel(hydrated, 'Item');
  assert.equal(
    columns(model, 'i'),
    '`i`.`item_id` AS `item_id`, `i`.`n` AS `n`',
  );
  const statement = yqlStatement({
    params: {
      id: optional(ydbUuid),
      rows: list(model),
      synthetic: list(struct({ n: ydbInt32 })),
    },
    results: {
      items: {
        decode: (row) => ({
          ...model.decode(row),
          total: ydbInt64.nativeConversions().decode(row.total),
        }),
      },
      summary: { count: ydbInt64 },
      fields: struct({ n: ydbInt32 }),
    },
    text: 'SELECT $id; SELECT * FROM AS_TABLE($rows); SELECT * FROM AS_TABLE($synthetic); -- DECLARE is permitted in a comment',
  });
  assert.match(statement.text, /^DECLARE \$id AS Optional<Uuid>;/);
  assert.ok(statement.text.includes(`DECLARE $rows AS ${model.listType};`));
  const target = {
    queryYql: async (request) => {
      assert.equal(request.text, statement.text);
      assert.equal(request.parameters.id.value.value.case, 'nullFlagValue');
      assert.deepEqual(request.parameters.rows.value.items, []);
      assert.deepEqual(request.parameters.synthetic.value.items, []);
      assert.equal(request.timeoutMs, 123);
      return {
        affectedRows: 0,
        resultSets: [
          { columns: [], rows: [{ item_id: 'one', n: 1, total: 2n }] },
          { columns: [], rows: [{ count: 3n }] },
          { columns: [], rows: [{ n: 4 }] },
        ],
      };
    },
  };
  const bound = (values, options?) => statement(target, values, options);
  assert.deepEqual(
    await bound({ id: null, rows: [], synthetic: [] }, { timeoutMs: 123 }),
    {
      items: [{ id: 'one', n: 1, total: 2n }],
      summary: [{ count: 3n }],
      fields: [{ n: 4 }],
    },
  );
  await assert.rejects(
    statement(
      { queryYql: async () => ({ affectedRows: 0, resultSets: [] }) },
      { id: null, rows: [], synthetic: [] },
    ),
    /result-set count mismatch/,
  );
  await assert.rejects(
    bound({ id: null, rows: [] }),
    /Missing YQL parameter: synthetic/,
  );
  assert.throws(
    () =>
      yqlStatement({
        params: {},
        text: 'DECLARE $x AS Int32; SELECT $x;',
      }),
    /must not contain DECLARE/,
  );
  assert.throws(
    () =>
      yqlStatement({
        params: { 'bad-name': ydbInt32 },
        text: 'SELECT 1;',
      }),
    /Invalid/,
  );
});

test('dynamic scalar results decode one column and reject unused parameters', async () => {
  const statement = yqlStatement({
    params: {},
    results: { total: ydbInt64 },
    text: 'SELECT 1;',
  });
  const target = {
    queryYql: async () => ({
      affectedRows: 0,
      resultSets: [{ columns: [], rows: [{ total: 2n }] }],
    }),
  };
  assert.deepEqual(await statement(target, {}), { total: [2n] });
  await assert.rejects(
    statement(
      {
        queryYql: async () => ({
          affectedRows: 0,
          resultSets: [{ columns: [], rows: [{ a: 1n, b: 2n }] }],
        }),
      },
      {},
    ),
    /exactly one column/,
  );
  assert.throws(
    () =>
      yqlStatement({
        params: { id: ydbInt32 },
        text: "SELECT 1; -- $id\nSELECT '$id';",
      }),
    /Unused YQL parameter/,
  );
});
