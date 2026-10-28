import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { defineYql, TimestampMicrosValue } from 'prisma-ydb/runtime';
import {
  parseSExpression,
  inferYqlResults,
} from '../../dist/control/yql-ast.js';
import { compileYqlType } from '../../dist/runtime/yql-types.js';
import {
  parseYqlParams,
  renderYql,
  yqlFunctionName,
} from '../../dist/control/yql-generate.js';

const fixtures = new URL('./fixtures/yql/', import.meta.url);
const load = async (name: string) =>
  JSON.parse(await readFile(new URL(`yql-${name}.json`, fixtures), 'utf8'));

test('YDB AST parser resolves aliases and physical result bindings in result order', async () => {
  assert.deepEqual(parseSExpression(`(a '"b\\n\\x21" '(c))`), [
    'a',
    ['quote', 'b\n!'],
    ['quote', ['c']],
  ]);
  const single = await load('single');
  assert.deepEqual(inferYqlResults(single.ast, single.plan, 'single.yql'), [
    [
      { name: 'amount', type: 'Optional<Decimal(22,9)>' },
      { name: 'at', type: 'Timestamp' },
      { name: 'id', type: 'Utf8' },
    ],
  ]);
  const multi = await load('multi');
  assert.deepEqual(inferYqlResults(multi.ast, multi.plan, 'multi.yql'), [
    [{ name: 'n', type: 'Int32' }],
    [
      { name: 'last', type: 'Optional<Timestamp>' },
      { name: 'total', type: 'Uint64' },
    ],
  ]);
  const none = await load('none');
  assert.deepEqual(inferYqlResults(none.ast, none.plan, 'none.yql'), []);
  assert.throws(
    () => inferYqlResults('(return (Unknown))', '', 'bad.yql'),
    /bad.yql: cannot infer result types/,
  );
  assert.throws(
    () => inferYqlResults(single.ast, none.plan, 'count.yql'),
    /count.yql: cannot infer result types/,
  );
});

test('YQL type compilation maps native inputs and decoded values', () => {
  for (const [name, output] of Object.entries({
    Bool: 'boolean',
    Int8: 'number',
    Int16: 'number',
    Int32: 'number',
    Uint8: 'number',
    Uint16: 'number',
    Uint32: 'number',
    Float: 'number',
    Double: 'number',
    Int64: 'bigint',
    Uint64: 'bigint',
    Utf8: 'string',
    String: 'Uint8Array',
    Uuid: 'string',
    Date: 'string',
    Timestamp: 'bigint',
    Json: 'JsonValue',
    JsonDocument: 'JsonValue',
    'Decimal(12,2)': 'string',
  }))
    assert.equal(compileYqlType(name).output, output);
  const compound = compileYqlType(
    'Struct<`odd key`: Optional<List<Tuple<Int64, Decimal(12,2)>>>>',
  );
  const value = { 'odd key': [[2n, '12.50']] };
  assert.deepEqual(compound.decode(value), value);
  assert.equal(
    compound.encode(value).items[0].items[0].items[0].value.value,
    2n,
  );
  assert.equal(
    compileYqlType('Utf8?').encode(undefined).value.case,
    'nullFlagValue',
  );
  const ts = compileYqlType('Timestamp');
  assert.equal(ts.decode(123456n), 123456n);
  assert.equal(ts.encode(new Date(123)).value.value, 123000n);
  assert.equal(
    ts.encode(new TimestampMicrosValue(123456n)).value.value,
    123456n,
  );
  for (const name of [
    'Datetime',
    'Interval',
    'Date32',
    'Timestamp64',
    'Dict<Utf8,Int32>',
    'Variant<Int32,Utf8>',
    'Tagged<Int32,tag>',
    'Yson',
  ])
    assert.throws(() => compileYqlType(name), /unsupported/i);
});

test('deterministic generation emits a snapshot from captured plans', async () => {
  const names = ['single', 'multi', 'none'];
  const sources = await Promise.all(
    names.map(async (name) => {
      const fixture = await load(name);
      return {
        file: `${name}.yql`,
        name,
        text: fixture.text,
        params: parseYqlParams(fixture.text, `${name}.yql`),
        results: inferYqlResults(fixture.ast, fixture.plan, `${name}.yql`),
      };
    }),
  );
  const text = renderYql(sources);
  assert.equal(
    text,
    await readFile(new URL('generated.snapshot.txt', fixtures), 'utf8'),
  );
  assert.equal(renderYql(sources), text);
  assert.equal(yqlFunctionName('wallet-history.yql'), 'walletHistory');
  assert.throws(() => yqlFunctionName('return.yql'), /reserved/);
  assert.throws(
    () => parseYqlParams('DECLARE $id AS Utf8; SELECT $idd;', 'typo.yql'),
    /typo.yql: Unused/,
  );
});

test('defineYql compiles codecs once and encodes/decodes single, tuple and void results', async () => {
  const fn = defineYql<
    { id: number; at: bigint; amount?: string | null },
    { at: bigint; amount: string | null }[]
  >({
    name: 'read',
    text: 'SELECT',
    params: [
      { name: 'id', type: 'Int64' },
      { name: 'at', type: 'Timestamp' },
      { name: 'amount', type: 'Decimal(12,2)?' },
    ],
    results: [
      [
        { name: 'amount', type: 'Decimal(12,2)?' },
        { name: 'at', type: 'Timestamp' },
      ],
    ],
  });
  const target = {
    queryYql: async (request) => {
      assert.equal(request.parameters.id.value.value.value, 2n);
      assert.equal(request.parameters.at.value.value.value, 123456n);
      assert.equal(request.parameters.amount.value.value.case, 'nullFlagValue');
      assert.equal(request.commit, false);
      assert.equal(request.timeoutMs, 100);
      assert.equal(request.valueMode, 'decoded');
      return {
        affectedRows: 0,
        resultSets: [{ columns: [], rows: [{ at: 123456n, amount: '12.50' }] }],
      };
    },
  };
  const values = { id: 2, at: 123456n };
  assert.deepEqual(
    await fn(target, values, { commit: false, timeoutMs: 100 }),
    [{ amount: '12.50', at: 123456n }],
  );
  await assert.rejects(
    fn(target, { ...values, extra: 1 }),
    /Unknown YQL parameter/,
  );
  await assert.rejects(fn(target, { at: 123456n }), /Missing YQL parameter/);
  const tuple = defineYql({
    name: 'tuple',
    text: '',
    params: [],
    results: [[{ name: 'n', type: 'Int32' }], [{ name: 's', type: 'Utf8' }]],
  });
  assert.deepEqual(
    await tuple(
      {
        queryYql: async () => ({
          affectedRows: 0,
          resultSets: [
            { columns: [], rows: [{ n: 1 }] },
            { columns: [], rows: [{ s: 'x' }] },
          ],
        }),
      },
      {},
    ),
    [[{ n: 1 }], [{ s: 'x' }]],
  );
  const none = defineYql({ name: 'none', text: '', params: [], results: [] });
  assert.equal(
    await none(
      { queryYql: async () => ({ affectedRows: 0, resultSets: [] }) },
      {},
    ),
    undefined,
  );
  await assert.rejects(
    none(
      {
        queryYql: async () => ({
          affectedRows: 0,
          resultSets: [{ columns: [], rows: [] }],
        }),
      },
      {},
    ),
    /result-set count mismatch/,
  );
});

test('DISCARD statements are attributed to result bindings by source order', async () => {
  const { yqlResultStatements } =
    await import('../../dist/driver/yql-syntax.js');
  const discarded = (text: string) =>
    yqlResultStatements(text)?.map((statement) => statement.discarded);
  assert.deepEqual(
    discarded('SELECT 1 AS a; DISCARD SELECT 2 AS b; SELECT 3 AS c;'),
    [false, true, false],
  );
  assert.deepEqual(
    discarded(
      "-- DISCARD SELECT 0;\nSELECT 'DISCARD; SELECT' AS a; /* DISCARD */ discard select 2 AS b",
    ),
    [false, true],
  );
  assert.deepEqual(
    discarded(
      'DECLARE $id AS Utf8; PRAGMA TablePathPrefix("/local"); $x = SELECT 1 AS z; DISCARD SELECT * FROM $x; (SELECT 1 AS u) UNION ALL (SELECT 2 AS u);',
    ),
    [true, false],
  );
  assert.deepEqual(
    discarded(
      'UPSERT INTO t (id) VALUES ($id); UPDATE t SET v = 1 WHERE id = $id RETURNING id; DELETE FROM t WHERE id = $id;',
    ),
    [false],
  );
  assert.equal(
    yqlResultStatements(
      'DEFINE ACTION $a() AS SELECT 1; END DEFINE; DISCARD SELECT 2;',
    ),
    undefined,
  );
  assert.equal(
    yqlResultStatements('EVALUATE FOR $i IN [1] DO $a($i); DISCARD SELECT 2;'),
    undefined,
  );
});
