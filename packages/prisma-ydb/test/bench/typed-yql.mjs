import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  defineYql,
  yqlStatement,
  ydbUtf8,
  ydbInt64,
  ydbTimestamp,
  ydbDecimal,
} from 'prisma-ydb/runtime';

// Both factories compile once, before warmup/timing. No database or per-call compilation.
const timestamp = {
  yqlType: 'Timestamp',
  wireType: () => ydbTimestamp.wireType(),
  wire: (v) => ydbTimestamp.wire(v),
  nativeConversions: () => ({
    encode: ydbTimestamp.nativeConversions().encode,
    decode: (v) => v,
  }),
};
const text = 'SELECT $id AS id, $at AS at, $limit AS n;';
const generated = defineYql({
  name: 'bench',
  text,
  params: [
    { name: 'id', type: 'Utf8' },
    { name: 'at', type: 'Timestamp' },
    { name: 'limit', type: 'Int64' },
  ],
  results: [
    [
      { name: 'id', type: 'Utf8' },
      { name: 'at', type: 'Timestamp' },
      { name: 'amount', type: 'Decimal(12,2)' },
    ],
  ],
});
const dynamic = yqlStatement({
  text,
  params: { id: ydbUtf8, at: timestamp, limit: ydbInt64 },
  results: {
    rows: { id: ydbUtf8, at: timestamp, amount: ydbDecimal.with(12, 2) },
  },
});
const rows = Array.from({ length: 100 }, (_, i) => ({
  id: `row-${i}`,
  at: 1767323045123456n,
  amount: '12.50',
}));
const response = { affectedRows: 0, resultSets: [{ columns: [], rows }] };
const target = { queryYql: async () => response };
const params = { id: 'one', at: 1767323045123456n, limit: 100n };
assert.deepEqual(
  await generated(target, params),
  (await dynamic(target, params)).rows,
);
const iterations = 20_000;
async function measure(fn) {
  for (let i = 0; i < 2000; i++) await fn(target, params);
  const times = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) await fn(target, params);
    times.push(((performance.now() - start) * 1000) / iterations);
  }
  times.sort((a, b) => a - b);
  return { medianUs: times[2], minUs: times[0], maxUs: times[4] };
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      iterations,
      samples: 5,
      rows: 100,
      params: 3,
      generated: await measure(generated),
      yqlStatement: await measure(dynamic),
      allocations:
        'Generated single-set decode allocates one row array and one output object per row; members/codec closures compile once. No per-column descriptors or key arrays in the row loop.',
    },
    null,
    2,
  ),
);
