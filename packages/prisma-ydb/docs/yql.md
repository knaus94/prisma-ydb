# Native YQL and data types

One client exposes ORM queries, a typed SQL builder and native YQL. Native
requests use YDB QueryService directly.

## Bind parameters

```ts
import { Text, Bool } from 'prisma-ydb/runtime';

const rows = await db.yql(
  `DECLARE $project AS Utf8;
   DECLARE $done AS Bool;
   SELECT id, title FROM \`Task\`
   WHERE projectId = $project AND done = $done LIMIT 50`,
  { project: new Text(projectId), done: new Bool(false) },
);
```

The text uses `$project`; the parameter object uses `project`. Each `DECLARE`
must match the supplied YQL type. Parameters are typed `@ydbjs/value` values,
re-exported by this package, or protobuf `{ type, value }` pairs. A plain string
cannot replace `new Text(...)`.

Bind user values as parameters. Table and column names cannot be value
parameters; choose dynamic identifiers from trusted application definitions.
ORM queries encode values automatically using the contract.

## Native UUID parameters

```ts
import { UuidValue, Optional, List, Struct } from 'prisma-ydb/runtime';

const id = new UuidValue('00112233-4455-6677-8899-AABBCCDDEEFF');
const rows = await db.yql(
  `DECLARE $rows AS List<Struct<id:Uuid,related:Uuid?>>;
   SELECT id, related FROM AS_TABLE($rows);`,
  { rows: new List(new Struct({ id, related: new Optional(null, id.type) })) },
);
// rows[0].id === '00112233-4455-6677-8899-aabbccddeeff'
```

ORM UUIDs and `UuidValue` require the hyphenated hexadecimal shape and normalize case.
`Uuid` remains the unmodified SDK primitive. Native UUID `ORDER BY` and range
comparisons use YDB byte order; JavaScript UUID string sorting can disagree.
Native decoding retains all 128 bits and returns lowercase strings, recursively
inside optional, list and struct results. Bind UUID values explicitly; a plain
string remains Utf8 unless a compiled ORM parameter declares the UUID codec.

## Result sets, timeouts and statistics

Use exact native typed values for parameterized decimals and microseconds:

```ts
import { DecimalValue, TimestampMicrosValue } from 'prisma-ydb/runtime';

await db.yql(
  'DECLARE $price AS Decimal(12,2); DECLARE $at AS Timestamp; SELECT $price AS price, $at AS at;',
  {
    price: new DecimalValue('1234.50', 12, 2),
    at: new TimestampMicrosValue('2026-10-22T12:34:56.123456Z'),
  },
);
```

Raw writes bypass `temporal.*` presets and client-side referential actions.
Supply automatic fields and maintain reference invariants explicitly.

```ts
const result = await db.queryYql({
  text: 'SELECT CurrentUtcTimestamp() AS ts; SELECT 1 AS n;',
  transactionMode: 'snapshotReadOnly',
  timeoutMs: 5000,
  stats: 'basic',
});
console.log(result.resultSets[0]?.rows, result.resultSets[1]?.rows);
```

`db.yql()` flattens rows across result sets. `db.queryYql()` preserves result-set
boundaries, column descriptors, `affectedRows` and optional statistics. Pass
`signal: controller.signal` to support caller cancellation.

Statistics are disabled by default. Native `affectedRows` is zero unless you
request `affectedRows: 'returning'`. For an exact mutation count:

```ts
const result = await db.queryYql({
  text: 'DECLARE $id AS Utf8; UPDATE `Task` SET done = TRUE WHERE id = $id RETURNING id;',
  parameters: { id: new Text(taskId) },
  affectedRows: 'returning',
});
console.log(result.affectedRows);
```

The count is the number of returned rows. Physical write statistics also count
index writes and are unsuitable for this purpose. ORM mutations use RETURNING,
including `updateAndCount` and `deleteAndCount`.

## Execution modes

| Mode               | Use                                                                             |
| ------------------ | ------------------------------------------------------------------------------- |
| `serializable`     | Default for native YQL: the batch runs in one read-write transaction            |
| `snapshotReadOnly` | Read-only statements observing one snapshot; select explicitly for native reads |
| `implicit`         | Execution without the driver's data-transaction wrapper; required for DDL       |

```ts
await db.transaction(async (tx) => {
  await tx.yql(
    'DECLARE $id AS Utf8; UPDATE `Task` SET done = TRUE WHERE id = $id;',
    { id: new Text(taskId) },
  );
  return tx.orm.Task.where({ id: taskId }).first();
});
```

Inside `tx`, native and ORM queries share the same transaction. Do not try to
switch it to implicit or read-only mode. Execute DDL outside an interactive
transaction with `db.queryYql({ text: ddl, transactionMode: 'implicit' })`.
Use [migrations](migrations.md) for managed schema changes: manual DDL does not
update the contract marker and can create drift. Implicit DDL does not retry
by default.

## JavaScript representations

| Type            | ORM                                                  | Decoded native YQL    |
| --------------- | ---------------------------------------------------- | --------------------- |
| Uuid            | canonical lowercase UUID `string`                    | UUID `string`        |
| Utf8            | `string`                                             | `string`              |
| Bool            | `boolean`                                            | `boolean`             |
| Int32           | `number`                                             | `number`              |
| Int64 / Uint64  | `bigint`                                             | `bigint`              |
| Double          | finite `number`                                      | `number`              |
| Timestamp       | DateTime: JS `Date`; Timestamp: six-digit UTC string | `bigint` microseconds |
| Date            | `YYYY-MM-DD` string                                  | JS `Date`             |
| Decimal         | exact decimal string; ORM default `Decimal(22,9)`    | exact decimal string  |
| String (binary) | `Uint8Array`                                         | binary value          |
| Json            | JavaScript JSON value                                | decoded JSON value    |

Converting large Int64 or Decimal values through `Number` can lose precision.
`JSON.stringify` needs an application-defined conversion for bigint values.
ORM `DateTime` results do not preserve YDB microseconds. Use schema `Timestamp`
or native values for exact precision. Use `valueMode: 'wire'` for
unmodified protobuf values and types, including types without a supported
JavaScript projection.

The runtime exports `Text`, `Bool`, numeric classes, `Timestamp`, `Optional`,
`List`, `Struct`, `DecimalValue` and other typed values. See the public
`prisma-ydb/runtime` declarations for the complete list. Contract lists store
Json arrays; native YQL list/struct parameters are also available.

## Buffering and streaming

ORM and high-level `db.queryYql()` calls buffer results until the server's
terminal status. Even `.first()` must surface late query or commit errors.
`maxResultRows` defaults to 100,000 and `maxResultBytes` to 32 MiB. Concurrent
queries multiply the potential memory consumption.

Use pagination or low-level `YdbDriver.queryYql()` streaming for large reads.
The latter returns `AsyncIterable<YdbQueryPart>`. Close an iterator when stopping
early; a `for await ... of` loop does so on `break`. Close the driver during
application shutdown. Automatic replay stops after the first yielded part.

```ts
import { YdbDriver } from 'prisma-ydb/driver';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

const driver = new YdbDriver();
try {
  await driver.connect(ydbBindingFromEnv());
  for await (const part of driver.queryYql({
    text: 'SELECT id, title FROM `Task` LIMIT 100',
    transactionMode: 'snapshotReadOnly',
  })) {
    console.log(part.resultSetIndex, part.rows);
  }
} finally {
  await driver.close();
}
```

Official references: [YQL](https://ydb.tech/docs/en/yql/reference/),
[YQL primitive types](https://ydb.tech/docs/en/yql/reference/types/primitive),
[YDB JS SDK](https://github.com/ydb-platform/ydb-js-sdk).
