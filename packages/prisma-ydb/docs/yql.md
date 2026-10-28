# Native YQL and data types

One client exposes ORM queries, a typed SQL builder and native YQL. Native
requests use YDB QueryService directly.

## Typed YQL files

Write plain YQL in `prisma/yql/*.yql`, relative to your Prisma config. Declare
every parameter in the file. Generate TypeScript against the same database schema
that the application will query:

```sql
-- prisma/yql/task-history.yql
DECLARE $projectId AS Utf8;
SELECT id, title, updatedAt FROM `Task`
WHERE projectId = $projectId ORDER BY id LIMIT 50;
SELECT COUNT(*) AS total FROM `Task` WHERE projectId = $projectId;
```

```sh
prisma-ydb yql generate
prisma-ydb yql generate --check
prisma-ydb yql generate --config ./prisma.config.ts --dir ./prisma/yql --output ./src/generated/yql.ts
```

The default output is `yql.ts` beside `contract.output` (Prisma represents that
setting as the `contract.json` file). `defineYdbConfig` also accepts
`yql: { dir: './prisma/yql', output: './src/generated/yql.ts' }`. All paths are
relative to the config directory. CLI flags override config and remain the
fallback for config-loader versions that reject custom sections.

`--check` compares the regenerated file byte for byte and fails if missing or
stale, without writing it. Exclude generated `yql.ts` files from formatters;
this repository already excludes `**/generated`. Commit the generated file and
run generation after migrations before checking it in CI.

```ts
import { taskHistory } from './generated/yql.js';

const [tasks, summary] = await taskHistory(
  db,
  { projectId },
  { timeoutMs: 5000 },
);
await db.transaction(async (tx) => {
  const [rows] = await taskHistory(tx, { projectId });
  console.log(rows[0]?.updatedAt); // bigint microseconds, nullable if the column is nullable
});
```

File names become camelCase function names (`task-history.yql` → `taskHistory`).
Invalid identifiers, reserved words and generated-name collisions fail generation.
Each function exports its `XParams`, `XRow` (or `XRow1`, `XRow2`, …) and `XResult`
types. One result set returns a row array, several return a tuple of row arrays,
and no result sets return `void`. Columns decode by name, independent of AST
member ordering. Calls accept `db` or `tx`, with `signal`, `timeoutMs` and `commit`
options. Required parameters must be present; optional parameters may be omitted
and encode as NULL. Unknown keys are rejected.

| YQL type                               | Generated input                    | Generated output    |
| -------------------------------------- | ---------------------------------- | ------------------- |
| Bool                                   | boolean                            | boolean             |
| Int8/16/32, Uint8/16/32, Float, Double | number                             | number              |
| Int64, Uint64                          | bigint or safe-integer number      | bigint              |
| Utf8, Uuid                             | string                             | string              |
| String                                 | Uint8Array                         | Uint8Array          |
| Decimal(p,s)                           | exact string                       | exact string        |
| Date                                   | YYYY-MM-DD string                  | YYYY-MM-DD string   |
| Timestamp                              | Date, bigint, TimestampMicrosValue | bigint microseconds |
| Json, JsonDocument                     | JsonValue                          | JsonValue           |
| Optional<T> / T?                       | T, null, undefined (key optional)  | T or null           |
| List<T>                                | readonly array                     | array               |
| Tuple<…>                               | readonly tuple                     | tuple               |
| Struct<…>                              | object                             | object              |

Datetime, Interval, extended 64-bit date types, Dict, Variant, Tagged, Yson and
other unsupported types fail generation with the file and type name. Timestamp
always means exact microseconds since the Unix epoch; converting it to `Date`
discards sub-millisecond precision.

The generator uses QueryService **EXPLAIN**, never EXECUTE. It parses parameter
`DECLARE`s and infers result types from the physical query's result bindings in
`execStats.queryAst`, resolving aliases and cross-checking the result count with
the JSON query plan. This depends on the AST format of pinned YDB 26.2.1.14;
revalidate on upgrades. Unknown plan shapes fail loudly instead of guessing.
EXPLAIN also keeps a binding for `DISCARD` statements, whose results never reach
the client; the generator drops them by source statement order. Files that mix
`DISCARD` with actions, subqueries or `EVALUATE`/`DO` blocks fail generation.
YDB diagnostics include the source file. Unused parameter declarations also fail,
catching typos before generation. Runtime type parsing and codec compilation run
once at module load, outside the per-call path. Generator modules are exported
only through `prisma-ydb/control` and the CLI, keeping them out of the runtime.

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

## Contract-derived model parameters and results

Use `yqlModel(contract, 'Task')`, or `db.yqlModel('Task')`, to derive native
YQL mappings from the same contract as the ORM. This avoids maintaining separate
column names, YQL declarations and typed-value constructors:

```ts
import { yqlModel } from 'prisma-ydb/runtime';

const task = yqlModel(db.contract, 'Task', {
  fields: ['id', 'title', 'done', 'createdAt', 'updatedAt'],
});
await db.yql(
  `${task.declare('rows', 'list')}
   UPSERT INTO ${task.table} SELECT * FROM AS_TABLE($rows);`,
  {
    rows: task.rows([
      {
        id: taskId,
        title: 'Hello',
        done: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]),
  },
);
const rows = await db.yql(`SELECT * FROM ${task.table} LIMIT 10;`);
const decoded = task.decodeAll(rows); // Contract field names and ORM value types.
```

`table` is a quoted physical path. `columns` provides the selected field names,
physical column names, YQL types (including optional markers), nullability and
list flags. `structType` and `listType` can be used in hand-written declarations;
`declare(name, 'struct' | 'list')` validates the parameter name and renders a full
`DECLARE` statement. Parameter names may include the leading `$`.

`rows()` encodes a typed `List<Struct<...>>`; `row()` encodes one typed
`Struct<...>`. Both share the bulk-upload codec encoder. With a generated
contract, input and decoded row types follow its field type maps, including enum
and JSON value-object refinements. Omit `fields` to select every stored field,
or provide a nonempty, unique list to select a projection. Unknown or unselected
input fields are rejected; missing nullable fields become NULL, while required
fields must be supplied. Presets, defaults and referential actions are bypassed.

`decode()` converts a native row's physical column names into the selected model
fields. It requires every selected column, ignores extra result columns, and
decodes Timestamp microseconds, Date, Decimal, JSON and scalar lists through
the contract codecs. DateTime becomes a JavaScript `Date` with millisecond
precision; Timestamp retains its six-digit UTC string. `decodeAll()` accepts
either flat native rows from `db.yql()` or a buffered `db.queryYql()` result,
flattening all its result sets. Use decoded native results rather than
`valueMode: 'wire'` with these helpers.

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
| Uuid            | canonical lowercase UUID `string`                    | UUID `string`         |
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

## Value-free descriptors and exact clocks

Every YDB codec descriptor has a cached `wireType()` returning its protobuf
Type. Compose types once and encode values without dummy scalar values:

```ts
import {
  optional,
  list,
  struct,
  ydbUuid,
  ydbDecimal,
} from 'prisma-ydb/runtime';

const price = ydbDecimal.with(12, 2);
const owner = optional(ydbUuid);
const items = list(struct({ owner, price }));
const typedNull = owner.wire(null);
const emptyItems = items.wire([]);
```

Containers expose the same `yqlType`, `wireType()`, `wire(value)` and
`nativeConversions()` methods. `optional` accepts null or undefined and decodes
NULL to null. `struct` rejects unknown and missing members. Int64/Uint64 inputs
also accept safe integer numbers, converted to bigint; outputs remain bigint.

DateTime writes accept `Date | bigint | TimestampMicrosValue` through model
rows, bulk uploads and ORM mutations. Bigints mean exact microseconds since the
Unix epoch, validated in YDB's 1970–2105 range. To retain exact model results:

```ts
const clock = db.yqlModel('Task', {
  fields: ['id', 'updatedAt'],
  micros: ['updatedAt'],
  extra: { owner: ydbUuid },
});
// updatedAt decodes to bigint; owner is encoded and decoded as a synthetic member.
```

`micros` requires selected scalar Timestamp fields. `extra` names must be valid
identifiers and cannot collide with any model field or physical column.
Encoding rejects row properties outside the model by default. Pass
`extraFields: 'ignore'` to encode wider domain objects directly: the model reads
only its own (and `extra`) fields and neither copies nor scans the row.
DateTime ORM results remain JavaScript Dates. In the pinned Prisma 8 ORM,
`Collection.select` accepts field names and provides no per-query codec or
computed-expression projection. Use the `Timestamp` scalar (`ydb/timestamp-us@1`)
for exact ORM columns. The separate native SQL builder supports raw computed
projections; it does not change DateTime model result types.

`nativeCodecConversions(codecId, typeParams?)` exposes synchronous native and
JSON encode/decode functions. Resolve these once outside row loops.
`timestampFromMicros(bigint)` formats six-digit UTC text;
`timestampMicros(textOrDate)` parses UTC text or a Date into bigint microseconds;
`timestampText(textOrDate)` normalizes six-digit UTC text. All validate the YDB
range. These helpers are public runtime exports.

## Dynamic statements

For dynamically assembled statements, compile a standalone statement once at
module scope. These descriptor types are authored by you; use Typed YQL files
when you want the database to infer and verify result types.

```ts
import { yqlStatement, yqlModel, ydbInt64 } from 'prisma-ydb/runtime';

const task = yqlModel(contract, 'Task', { fields: ['id', 'title'] });
const load = yqlStatement({
  params: { limit: ydbInt64 },
  results: { tasks: task },
  text: `SELECT * FROM ${task.table} LIMIT $limit;`,
});
const result = await load(db, { limit: 50 });
await db.transaction(async (tx) => load(tx, { limit: 10n }));
console.log(load.text); // Includes generated DECLAREs.
```

`params` accepts scalar descriptors, `optional`, `list`, `struct` and `yqlModel`
handles. Declarations are generated automatically: do not put `DECLARE` in the
text. Missing, unknown and unused parameters fail. Typed NULLs and empty lists
retain their wire types.

`results` names result sets in JavaScript property iteration order. Each entry
accepts a model decoder, a struct descriptor, a plain codec field map, or a scalar
descriptor. Scalars decode the sole column of each row and reject rows with any
other column count. Use `yqlModel(..., { extra })` for synthetic typed columns.
Omit `results` to receive the native buffered `YdbQueryResult`; `{}` requires no
result sets. A result-set count mismatch throws.

The returned callable is `statement(target, values, options?)` with `.text`.
Options forward native cancellation, timeout and transaction settings. There are
no `db.yqlStatement` or `tx.yqlStatement` factories. `columns(model, alias?)`
renders safely quoted physical columns. Use `struct` for descriptor fields;
`fields` and `withColumns` were removed.
