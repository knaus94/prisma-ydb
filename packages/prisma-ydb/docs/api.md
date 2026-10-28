# Native YDB target for Prisma ORM 8

This package integrates the Prisma SQL-family runtime and control plane
with native YDB QueryService/SchemeService/TableService RPCs. The driver follows
Prisma's TypeScript
`SqlDriver`, `SqlConnection` and `SqlTransaction` interfaces.

Pinned compatibility: Prisma CLI `8.0.0-rc.24`, its embedded ORM packages
`8.0.0-rc.18`, `@ydbjs/core` `6.3.1`, local YDB `26.2.1.14`. This is a custom
implementation against a release candidate. It has not been qualified for
production clusters or certified by Prisma/YDB.

## Entry points

| Import                   | Purpose                                                   |
| ------------------------ | --------------------------------------------------------- |
| `prisma-ydb/runtime`     | `ydb`, `YdbClient`, codecs, native typed values           |
| `prisma-ydb/driver`      | Low-level driver, native streaming API, structured errors |
| `prisma-ydb/config`      | `defineYdbConfig` for the official Prisma CLI             |
| `prisma-ydb/control`     | Native schema, migrations and `generateYql`               |
| `prisma-ydb/environment` | `ydbBindingFromEnv` for SDK auth/TLS conventions          |

The root export contains the runtime factory and low-level driver. Control-plane
code is also available through an explicit subpath. Generated contracts are
consumed through the package's YDB contract serializer.

## Typed native queries

`prisma-ydb yql generate` compiles `prisma/yql/*.yql` into typed functions using
YDB EXPLAIN result types. `--check` detects stale generated files without writing.
The programmatic `generateYql({ config?, dir?, output?, check? })` lives in
`prisma-ydb/control`. Configure paths with `defineYdbConfig({ ..., yql: { dir,
output } })` or CLI flags. The runtime exports `defineYql<Params, Result>`;
generated functions call `fn(dbOrTx, params, { signal?, timeoutMs?, commit? })`.
Timestamp results are bigint microseconds; optional inputs may be omitted as NULL.
See [Typed YQL files](yql.md#typed-yql-files) for supported types and result shapes.

Dynamic `yqlStatement({ params, results?, text })` returns the same callable shape
with `.text`, and compiles once at definition. Scalar result descriptors decode a
single-column row. Required, unknown and unused parameters are checked. Use
`optional`, `list`, `struct`, `columns` and model `extra` members when assembling
statements. The old contract argument, bound client/transaction factories,
`fields` and `withColumns` have been removed.

## Client

```ts
import { ydb, Bool } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import type { Contract } from './generated/contract.d.js';
import contractJson from './generated/contract.json' with { type: 'json' };

const db = ydb<Contract>({
  contractJson,
  binding: ydbBindingFromEnv(),
  driverOptions: {
    maxSessions: 16,
    maxWaiters: 128,
    acquireTimeoutMs: 5000,
    queryTimeoutMs: 15000,
    transactionTimeoutMs: 30000,
    maxResultRows: 100000,
    maxResultBytes: 32 * 1024 * 1024,
  },
});
try {
  await db.connect();
  await db.orm.Task.create({ title: 'Hello', createdAt: new Date() });
  await db.orm.Task.where({ done: false })
    .select('id', 'title')
    .limit(50)
    .all();
  await db.yql(
    'DECLARE $done AS Bool; SELECT id FROM `Task` WHERE done = $done',
    {
      done: new Bool(false),
    },
  );
} finally {
  await db.close();
}
```

The sample Nest singleton is in [Nest integration](nestjs.md).
Use one client per application, and return/close every low-level connection or
iterator acquired directly. Client `close()` refuses new work and applies one
`closeTimeoutMs` deadline (default 30000) to Prisma runtime drain and native
driver shutdown together. If runtime drain exceeds it, shutdown abandons leases
and rejects with `SqlConnectionError('YDB client close timed out waiting for in-flight operations')`.
The low-level driver also bounds lease/background cleanup, reports abandoned
leases on timeout, and accepts an explicit `close(timeoutMs)` budget. Repeated
close calls return the same promise.

For readiness probes, use `await db.health({ timeoutMs: 1000 })`, the native
driver's `health()`. The optional
`signal` cancels the probe. Health never implicitly connects or throws: it returns
`ready`, `state` (`unbound`, `connecting`, `connected`, `closing`, or `closed`),
a `pool` snapshot, and optional `latencyMs` and sanitized `error` details.
Only a connected driver sends `SELECT 1`, using a snapshot read-only transaction
without retries. Its default timeout is the smaller of 5000ms and
`queryTimeoutMs`; other states return `ready: false` without an RPC.
Client readiness becomes false as soon as `close()` starts, including while
Prisma drains pending work and when an earlier readiness probe finishes during shutdown.

## String enums

Declare enums in the authored `.prisma` contract and run `prisma contract emit`:

```prisma
enum TaskStatus {
  TODO
  DOING
  DONE
}

model Task {
  id     String     @id @default(uuid())
  status TaskStatus @default(TODO)
}
```

The column uses YDB `Utf8` and the `ydb/utf8@1` codec. Generated input and output
types contain the permitted string literals, including in filters and selections.
`TaskStatus?` adds `null`; a default lets creates omit the field.

```ts
const Status = db.enums.TaskStatus;
type TaskStatus = typeof Status.Value;

await db.orm.Task.create({ status: Status.members.TODO });
const tasks = await db.orm.Task.where({ status: Status.members.DOING }).all();

function parseStatus(value: unknown): TaskStatus {
  if (!Status.has(value)) throw new TypeError('Unknown task status');
  return value;
}
```

The accessor also exposes `values`, `names`, `hasName`, `nameOf` and `ordinalOf`.
`Value` is type-only: use it in `typeof`, never read it at runtime.
`db.enums.__unbound__.TaskStatus` remains available and refers to the same accessor.
Transactions expose the same API through `tx.enums.TaskStatus`. Enum access does
not require connecting to YDB. If an enum is named `__unbound__`, use
`db.enums.__unbound__.__unbound__` to avoid the namespace-name collision.

By default each member stores its name. Explicit values use Prisma 8 syntax,
for example `TODO = "todo"`; then `Status.members.TODO` and query results contain
`"todo"`. There is no ordinal conversion. The client does not automatically
validate enum membership on reads or writes, and YDB has no corresponding
constraint. Validate external data with `.has()`; values written through `any`,
JavaScript or direct YQL can otherwise fall outside the generated type.

Contract printing preserves string enum definitions, field types and defaults.
Database inference returns `String` because YDB stores no enum definition.
Enum-only changes update contract metadata and hashes without changing the
physical column; follow the usual migration/snapshot workflow.

## Driver options and retries

The following driver options supplement the limits shown above. Unknown option
keys and invalid values throw `TypeError`.

| Option                  | Default              | Behavior                                                                                               |
| ----------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `minSessions`           | `0`                  | Best-effort warmup in `connect()`; must not exceed `maxSessions` (default `16`).                       |
| `sessionMaxIdleMs`      | `300000`             | Retire idle sessions beyond the warm minimum.                                                          |
| `sessionMaxAgeMs`       | `3600000`            | Retire aged sessions on pool acquisition/return or background sweep.                                   |
| `sessionCloseTimeoutMs` | `2000`               | Bound a DeleteSession RPC.                                                                             |
| `closeTimeoutMs`        | `30000`              | Bound client runtime drain and driver shutdown together.                                               |
| `readTransactionMode`   | `'snapshotReadOnly'` | Mode for compiler-tagged SELECTs outside interactive transactions; `'serializable'` is also supported. |
| `statsMode`             | `'none'`             | Native query statistics; opt into `'basic'` explicitly.                                                |
| `retry`                 | enabled              | `false` disables driver retries; an options object overrides the retry defaults below.                 |

Retry defaults are `maxAttempts: 5` (including the first attempt),
`baseDelayMs: 10`, `maxDelayMs: 1000`, `overloadedBaseDelayMs: 200`, and
`overloadedMaxDelayMs: 5000`. Delays use capped exponential backoff with full
jitter; bad/busy/expired sessions retry immediately with a fresh session.
`retryDefaults` and `retryDelayMs` are exported for callers that implement their
own retry loops around low-level handles.
Overload and transport resource-exhaustion errors use the overload delay range.
All attempts share one query deadline, including acquisition and backoff.

Driver-owned `query`, `execute`, `queryYql`, and `executeYql` calls retry
`ABORTED`, `OVERLOADED`, `UNAVAILABLE`, `BAD_SESSION`, and `SESSION_BUSY` errors.
`SESSION_EXPIRED`, `UNDETERMINED`, `TIMEOUT`, and transport errors require an
idempotent request: `idempotent: true`, `transactionMode: 'snapshotReadOnly'`,
or a compiler-tagged SELECT. Streaming `queryYql` stops retrying after its first
yielded part. Request `retry: false` disables replay; implicit-mode DDL defaults
to no retry, and control-plane DDL explicitly disables it. Driver retries never
replay low-level connection/transaction calls or statements inside an interactive
transaction. Errors marked `outcomeUnknown` are never retried.

`classifyYdbError(error)` exposes structured classification through cause chains
and the primary failure of transaction aggregates: `kind`, `status`,
`outcomeUnknown`, `retryable`, `retryableIfIdempotent`, `uniqueViolation` and an
optional `ensure.message`. Only the authored Ensure message is retained by
default; other server issue text stays hidden. Status 400120 by itself does not
establish Ensure or uniqueness.

`withRetry(fn, { budgetMs, signal?, idempotent?, maxAttempts?, onRetry?, ...delays })`
retries autocommit work within one total budget including backoff. `fn` receives
an abort signal to forward to the request. It never replays uncertain outcomes,
application errors or cancellation, and rethrows the last failure on exhaustion.
Both helpers are exported from runtime and driver entry points. See
[error classification and autocommit retries](transactions.md#error-classification-and-autocommit-retry-helper)
for the complete behavior and an example.

Every `onEvent` includes a `pool` snapshot after the operation. Native session
creation, including warmup, reports `operation: 'session-create'`, duration and
success/failure. Retries report `operation: 'retry'`, the next `attempt`, and
status when available. `db.stats()` and the native driver's `stats` getter return
`maxSessions`, `idle`, `leased`, `creating`, `waiters`, and `closing` counts.
`closing` counts background cleanup operations. Driver-owned calls return their
original query error without waiting for cleanup of a tainted session; its
admission slot remains held until cleanup settles. `destroy()` bounds server
cleanup, disposes locally even if it fails, and reports cleanup failure through
`onEvent`. Misuse, such as destroying an active stream or a disposed connection,
still throws.

A session survives statement failures that end with a server status, such as
constraint violations, syntax errors and `ABORTED` conflicts, and a definite
commit failure only requires the transaction to be rolled back. The session is
retired after transport loss, `BAD_SESSION`/`SESSION_EXPIRED`/`SESSION_BUSY`,
a commit whose outcome is unknown, a failed rollback, or a native stream that the
caller abandoned before its terminal status. Warm-up opens the missing
`minSessions` in parallel and skips when the pool is fully leased.

## Transactions and raw YQL

`db.transaction(async tx => ...)` provides `tx.orm`, `tx.sql`, `tx.raw`, `tx.enums`,
`tx.query`, `tx.execute`, `tx.yql` and `tx.queryYql` on one native session and
transaction ID. Success awaits commit acknowledgement; failure awaits rollback.
Transaction callbacks are not retried by default. Opt in with
`db.transaction(callback, { retry: true })` (at most five total attempts), or
`{ retry: { maxAttempts: 3 } }`. Each retry runs the entire callback on a fresh
connection after a retryable server failure, including an `ABORTED` commit.
Callback retries use the same configurable backoff as driver requests, including
`overloadedBaseDelayMs`/`overloadedMaxDelayMs` for `OVERLOADED`. If driver retries
are disabled, explicitly enabled callback retries use the default delays.
Callbacks must tolerate repeated execution and side effects outside YDB.
Retry classification uses the primary failure even when drain, rollback or
cleanup errors wrap it in an `AggregateError`. A failed nested mutation retains
its underlying driver error as the invalidation error's `cause`, so a retryable
primary failure can retry the whole callback. Transaction timeouts, user errors,
transport errors and `outcomeUnknown` failures are not retried by this option.
A callback is never retried after commit succeeds, including if later cleanup
fails. An `outcomeUnknown` error requires reconciliation before retrying a mutation.

Interactive transactions use Serializable read-write mode. Nested transactions,
savepoints, row-locking clauses and other isolation levels are unsupported.
A transaction handle cannot be used after settlement. Queries on one session are
serialized by a lock owned by the native session and shared across its leases.
Released handles recheck their state after waiting for that lock; a connection
with waiting operations cannot return to the pool. Callback duration is bounded
by `transactionTimeoutMs`, and expiry cancels in-flight statements before rollback.

With marker verification enabled, the marker is read once per client through the
native driver outside any transaction, including when `transaction()` is the
first operation. Before an interactive transaction or ORM nested mutation takes
a pool session, marker warmup finishes, avoiding a marker-read deadlock with
`maxSessions: 1`. A rejected read clears the memo so a later operation retries.
The query binds `APP_SPACE_ID` from Prisma's control API as Utf8; control-plane
marker defaults and migration planning use the same constant. Missing-table
classification requires `SCHEME_ERROR` plus an authoritative SchemeService
existence check, without matching error or issue text. Other failures propagate.

Prisma reports MISSING/MISMATCH marker warnings per runtime: at most twice per
client, once from the first transaction runtime that verifies and once from the
main runtime on its first use. Later transaction runtimes neither reread nor log.
A held connection obtained directly through `db.runtime().connection()` does not
perform marker warmup before acquisition. Codec registry completeness is
validated once per client before its first interactive transaction.

Nested ORM mutation graphs share the outer transaction. A failed nested graph
invalidates that transaction, including when the callback catches its exception:
part of a parent/child write cannot then be committed. Without an outer callback,
Prisma's mutation executor opens and settles a native transaction for the graph.

Ordinary ORM calls compile their YQL text on every invocation; the driver only
caches the parsed statement metadata. For hot paths that repeat one query shape
with different values, prepare the query once.
`db.prepare(declaration, callback)` uses Prisma's prepared plan API: compilation
and result-decoder setup are reused, while each call binds and validates values.
Pass the client directly to the prepared handle: `await prepared.query(db, params)`.
The same handle accepts a live `tx` from `db.transaction`; its queries stay on that
transaction and reject once it settles. The bridge retains runtime middleware,
codec validation, cancellation and operation tracking. It does not expose a
server-side prepared statement handle or native cache policy.

`db.yql(text, parameters)` returns flattened native result rows. Parameters must
be typed values, for example `new Text('id')`, `new Bool(false)` or `new Int64(1n)`.
Never interpolate untrusted input into YQL text. `db.raw` is Prisma's parameterized
raw lane; native YQL can also be used with explicit result sets and cancellation:

```ts
const result = await db.queryYql({
  text: 'SELECT CurrentUtcTimestamp() AS ts',
  signal: AbortSignal.timeout(5000),
});
const micros = result.resultSets[0]?.rows[0]?.['ts']; // bigint, no precision loss

// Full protobuf values/types for YQL types without a JavaScript projection:
await db.queryYql({ text: 'SELECT 1 AS n', valueMode: 'wire' });
```

Outside interactive transactions, compiler-tagged SELECTs use one snapshot
read-only transaction by default and observe writes committed before its snapshot. Set
`readTransactionMode: 'serializable'` to change that default. Raw native batches
keep one Serializable transaction unless the request selects
`transactionMode: 'snapshotReadOnly'`. Request `stats: 'basic'` enables native
statistics for one call; statistics are otherwise disabled by default.
DDL explicitly uses
`queryYql({ text: 'CREATE TABLE ...', transactionMode: 'implicit' })` outside a
transaction. Prefer migrations for application schema changes. Raw DDL does not
update the Prisma contract marker.

The low-level `YdbDriver.queryYql` streams parts. Prisma queries buffer bounded
results until the terminal server status, so `.first()` cannot hide a late
commit/query failure. Use pagination or native streaming for large results.
Native `affectedRows` is zero unless `affectedRows: 'returning'` is requested;
that mode counts returned rows. ORM mutations always emit `RETURNING`. Physical
write statistics are not used as row counts because index updates inflate them.
For a native mutation count, use `queryYql` with a `RETURNING` clause and
`affectedRows: 'returning'`. `execute()` accepts compiled mutation plans; an
unannotated raw plan is rejected before execution because its row-count semantics
are unknown. Raw reads can run through `query()`.
The same bounds apply to `updateAndCount`/`deleteAndCount`, which count returned
rows. Split large mutations into bounded batches when necessary.

## Streaming, bulk writes and changefeeds

`db.streaming` exposes the same `orm`, `sql` and `raw` lanes bound to a driver
that yields rows as the server streams them, without the `maxResultRows` and
`maxResultBytes` bounds:

```ts
for await (const task of db.streaming.orm.Task.where({ done: false }).all()) {
  await exportRow(task);
}
```

Consume the iterator completely. Leaving it early (`break`, `first()`, an
exception) cancels the RPC, so the session's outcome is unknown and it is
discarded instead of returned to the pool. Retries stop once the first row has
been delivered. Streaming is not available inside `db.transaction`.

`db.bulkUpsert(model, rows, { chunkSize, timeoutMs, signal })` encodes model rows
through the contract codecs and writes them with TableService `BulkUpsert`: an
idempotent, chunked (default 1000 rows), retried upload that runs outside any
transaction and is far cheaper than `UPSERT` statements for large loads. Every
row must carry the full primary key. The upload touches only the fields it
carries: a field absent from every row is left untouched, a field present in some
rows is written as `NULL` for the others (nullable fields only). Column tables
require every column per row, so their uploads always carry the full row. Like
raw YQL, it bypasses `temporal.*` presets and client-side referential actions.

`db.changefeed(model, { consumer, fields?, feed?, limit?, waitMs?, partitionIds?, readFrom?, maxLagMs?, signal? })`
reads a managed `@@changefeed` topic (`format: Json`) and yields batches of
decoded events:

```ts
for await (const batch of db.changefeed('Order', { consumer: 'app' })) {
  for (const event of batch.events) {
    // event.kind: 'update' | 'erase'; event.key, event.newImage, event.oldImage, event.updates
  }
  await batch.commit();
}
```

Values are decoded with the model's codecs: `BigInt`/`Uint64` as exact `bigint`
(YDB writes them as bare JSON numbers, which are parsed from their source text,
never through doubles), `Decimal` as a string, `Date` as `YYYY-MM-DD`, lists as
arrays. `fields: ["note", "status"]` decodes only those model fields plus every
primary key field, including images and updates; `fields: []` keeps only keys.
Unselected fields remain available through lazy `event.raw`. Projection is compiled
once per reader. Unmapped columns are ignored. `event.raw` keeps the server record with
integers beyond `Number.MAX_SAFE_INTEGER` as decimal strings. It is computed
on first access, cached, and remains enumerable for serialization. `event.ts` is set
only when the feed records virtual timestamps. `feed` is required when the model
declares several changefeeds, and the consumer must exist on the topic (declare
it in `consumers`). The iterator ends when `signal` aborts or the client closes;
uncommitted batches are delivered again to the next reader of that consumer.

Partition hooks follow assignment and rebalancing:

```ts
for await (const batch of db.changefeed('Order', {
  consumer: 'app',
  // Resume from offsets kept with your own data; return nothing to use the consumer's.
  onPartitionStart: async ({ partitionId }) => {
    const stored = await loadOffset(partitionId);
    return stored === undefined ? undefined : { readOffset: stored };
  },
  // The partition moves to another reader; drop per-partition state.
  onPartitionStop: ({ partitionId }) => forgetPartition(partitionId),
  onCommitted: ({ partitionId, committedOffset }) =>
    metrics.offset(partitionId, committedOffset),
})) {
  await apply(batch.events);
  await batch.commit();
}
```

Each hook receives `partitionId`, `partitionSessionId`, `committedOffset` and the
retained `startOffset`/`endOffset`, plus `retentionExpired` when
`committedOffset < startOffset`. A start position may set `commitOffset` and
`readOffset` (not below the commit offset); omitted fields keep the server's
committed position. Reading of a partition waits for its start hook. An
exception thrown by a hook ends the iteration with that error. Committing a batch
of a partition that has since been taken away rejects with an `Error`; its
messages are redelivered to the partition's next reader.

The start-hook partition and every batch partition expose `stop(reason?)`,
`pause()` and `resume()`, plus `stopped`, `paused` and `stopReason`. Stop refuses
that assignment without ending the iterator, drops buffered records and prevents
future commits through its handles. Direct `commit()`, `commitThrough()` and
`skip()` calls on a stopped handle reject with an `Error` naming the stop reason;
`batch.commit()` skips stopped partitions. Call it in `onPartitionStart` to refuse a gap
without throwing. Pause buffers future delivery until resumed; already yielded
events remain yours to process. Buffering uses `maxBufferBytes` (default 16 MiB);
once this budget is reached, the reader applies backpressure until a paused
partition resumes or stops. Other partitions continue while buffer space remains. Pause is a short local
hold; use `stop()` for long refusal so a paused backlog cannot stall other partitions.

```ts
for await (const batch of db.changefeed('Order', {
  consumer: 'app',
  fields: ['status'],
  onPartitionStart: (partition) => {
    if (partition.retentionExpired) partition.stop('needs backfill');
  },
})) {
  for (const partition of batch.partitions) {
    for (const event of partition.events) {
      if (isPoison(event)) {
        await deadLetter(event);
        await partition.skip(event);
      } else await apply(event);
    }
    await partition.commit();
  }
}
```

`commitThrough(event)` and its alias `skip(event)` explicitly acknowledge all
offsets through that decoded event, inclusive. Process or quarantine every earlier
event first. Events must belong to that partition batch. A stopped handle rejects new direct commits; an acknowledgement already sent before stop may still arrive.

Batches also expose `partitions`, each with `partitionId`, `partitionSessionId`,
`events`, `errors` and `commit()`. A malformed record becomes an error entry
`{ partitionId, partitionSessionId, offset, error, payload }`; it does not end the
iterator. The payload is the original `Uint8Array`. The affected assignment is
quarantined: subsequent records are drained without delivery or acknowledgement,
while other partitions continue. `batch.commit()` acknowledges only groups with
no errors; a partition group's `commit()` acknowledges its decoded prefix only,
never the failed record or anything after it. Process that prefix before committing.

`@ydbjs/topic` 6.1.4 has no public reader method to release a single partition
assignment to the server. Its session `stop()` only changes local state. Refusal
and quarantine are therefore client-side and still consume network bandwidth;
another reader can take the partition after server reassignment or reader closure. A new assignment retries
from the stored consumer offset. To explicitly skip a repaired/dead-lettered
record, close the iterator and restart it with `onPartitionStart` returning
`{ readOffset: badOffset + 1n, commitOffset: badOffset + 1n }` for that partition.
This deliberately advances its checkpoint; persist any required prefix first.

`db.topic()` returns the `@ydbjs/topic` client on the same connected gRPC driver:

```ts
const writer = db.topic().createWriter({ topic: '/local/application-events' });
try {
  writer.write(new TextEncoder().encode(JSON.stringify({ type: 'updated' })));
  await writer.flush();
} finally {
  await writer.close();
}
```

Close readers and writers you create before closing `db`. The exported
`topicClient(driver)` helper provides the same access for a connected `YdbDriver`.

## Type mapping

| Contract scalar | YDB storage     | JavaScript                                 |
| --------------- | --------------- | ------------------------------------------ |
| `Uuid`          | `Uuid`          | canonical lowercase UUID `string`          |
| `String`        | `Utf8`          | `string`                                   |
| `Int`           | `Int32`         | checked integer `number`                   |
| `BigInt`        | `Int64`         | `bigint` output; safe integer number input |
| `Uint64`        | `Uint64`        | range-checked unsigned `bigint`            |
| `Boolean`       | `Bool`          | `boolean`                                  |
| `Float`         | `Double`        | finite `number`                            |
| `DateTime`      | `Timestamp`     | `Date` output; exact bigint micros input   |
| `Date`          | `Date`          | UTC calendar string `YYYY-MM-DD`           |
| `Timestamp`     | `Timestamp`     | UTC ISO string with six fractional digits  |
| `Json`          | `Json`          | JSON values, including scalar strings/null |
| `Bytes`         | binary `String` | `Uint8Array`                               |
| `Decimal`       | `Decimal(22,9)` | exact decimal `string`                     |
| `Decimal(p, s)` | `Decimal(p,s)`  | exact decimal `string`                     |

ORM `DateTime` decoding, including relation includes, truncates microseconds to
milliseconds. Native relation formatting preserves fractional seconds before
ORM decoding. DateTime writes accept a `Date`, exact `bigint` microseconds, or a
`TimestampMicrosValue`, including ORM mutations, `yqlModel` and `bulkUpsert`.
All forms validate the YDB range. DateTime ORM results remain `Date` values;
use the `Timestamp` schema scalar for exact ORM reads, or a native model with
`micros: ['fieldName']` for bigint results. Int64 and Uint64 inputs accept safe
integer numbers and convert them to bigint; unsafe numbers remain errors.

`ydbDecimal.with(precision, scale)` returns a regular descriptor with `yqlType`,
`wire(value)`, `wireType()` and `nativeConversions()`. The unparameterized
`ydbDecimal` and schema `typeParams` retain their `(22,9)` default behavior.
Every scalar descriptor exposes a cached protobuf `wireType()` without a value.
`optional`, `list` and `struct` compose descriptors, including typed NULLs and
empty lists. See [typed native YQL](yql.md) for examples.

Raw Timestamp values preserve microseconds as `bigint`. Raw Decimal values
preserve exact decimal strings; native `DecimalValue` accepts explicit precision
and scale up to YDB's precision limit of 35. Non-finite decimals and nonzero
digits beyond the requested scale are rejected. Aggregate `count()` and integer `sum()` reject
unsafe number conversion; use the bigint variants for larger values. Scalar and
enum lists use Json columns; native YQL list/struct parameters remain available.
The pinned Prisma SQL-family validator rejects a non-nullable `Json` field with
a literal JSON-null storage default. Nullable JSON defaults can represent JSON
null; use native wire mode when the distinction from SQL NULL must be inspected.

`Decimal(p, s)` accepts precision 1–35 and scale 0–precision. Both arguments are
required together; bare `Decimal` remains `(22,9)` and keeps its contract shape.
Use exact strings, such as `'1234.50'`, without exponent notation.
`Date` accepts a real calendar-date string or a JS `Date` (its UTC calendar day).
`Timestamp` accepts UTC strings with zero to six fractional digits, or a JS `Date`
(milliseconds padded to microseconds). Output is canonical, for example
`2026-10-22T12:34:56.123456Z`. All three temporal codecs accept dates from 1970
through 2105. Date32 and Timestamp64 are outside this target's schema support.

`Uuid` stores native YDB UUID values, including in composite primary keys and
synchronous unique indexes. Inputs require the hyphenated hexadecimal shape;
uppercase hex normalizes to lowercase. UUID versions and variants are not
restricted, so deterministic operation IDs and nil UUIDs are valid identities.
UUID generators use `@default(uuid())` or `@default(uuid(7))`. A storage
literal uses the typed form ``@default(uuid`00112233-4455-6677-8899-aabbccddeeff`)``.
The existing `Uuid` export remains the SDK primitive with its original input
semantics; `UuidValue` adds validation and is also exported from the root.
The UUID codec's `order` trait means YDB's native internal byte ordering, which
can differ from JavaScript's canonical-string sorting. Use server `ORDER BY` and
server comparisons together for seek pagination; do not mix a TS string sort
with a native UUID cursor.
Use `new UuidValue(value)` for validated native YQL parameters,
including `Optional`, `List` and `Struct` containers. It keeps the SDK's 128-bit
representation; money and UUID values never pass through JavaScript numbers.

## Automatic timestamps

Use native Prisma 8 field presets:

```prisma
createdAt temporal.createdAt()
updatedAt temporal.updatedAt()
publishedOn temporal.Date(onCreate: now)
observedAt temporal.Timestamp(onCreate: now, onUpdate: now)
```

`temporal.createdAt()` sets a DateTime on create; `temporal.updatedAt()` sets it
on create and every nonempty update. `temporal.DateTime`, `temporal.Date` and
`temporal.Timestamp` accept optional `onCreate: now` and `onUpdate: now` phases.
One application timestamp is shared by defaults of a lowered mutation.
Raw YQL writes bypass these defaults. `@default(now())` is rejected; use a preset.
Presets cannot be optional (`?`) in rc.18. Adding a required timestamp to a populated
table needs a reviewed backfill, as shown by the basic example migrations.

## Value objects and JSON paths

Prisma `type` blocks describe typed value objects, including nested objects;
their fields are stored in a single `Json` column. For example:

```prisma
type Settings {
  theme String?
}
model Project {
  id String @id
  settings Settings?
}
```

JSON fields expose `jsonString(path)`, `jsonNumber(path)`, `jsonBoolean(path)`,
`jsonExists(path)` and `jsonIsNull(path)`. String/number results support comparisons:

```ts
db.orm.Project.where((p) => p.settings.jsonString('theme').eq('dark'));
db.orm.Project.where((p) => p.settings.jsonBoolean('notifications.email'));
```

Paths are dotted strings or arrays of string/number segments, such as
`['items', 0, 'name']`. They are strictly validated, escaped JsonPath literals in
the query text; YDB does not accept a JsonPath parameter. Control characters and
empty keys are rejected.

| Column/path state | jsonString/Number/Boolean             | jsonExists | jsonIsNull |
| ----------------- | ------------------------------------- | ---------- | ---------- |
| SQL NULL column   | NULL                                  | NULL       | NULL       |
| Missing path      | NULL                                  | false      | false      |
| JSON null         | NULL                                  | true       | true       |
| Present scalar    | Value if type matches, otherwise NULL | true       | false      |

Predicates select only true. `jsonBoolean` is a nullable predicate: use it directly
for JSON true. `not(p.settings.jsonBoolean(path))`, with `not` imported from
`@prisma/orm-family-sql/orm-client`, matches explicit false; missing/null values
remain NULL and do not match.

## Scalar and enum lists

`String[]`, numeric, Boolean, Decimal, temporal, Bytes and enum lists store a Json
array of each element's JSON form. BigInt uses decimal strings, Bytes uses base64,
and temporal values use UTC strings. Elements cannot be null. Json/value-object
lists are rejected. Reads decode the element codec; writes replace the whole
array. Atomic push/remove and PostgreSQL array parity are not supported.

```ts
await db.orm.Project.where({ id }).update({ tags: ['prisma', 'ydb'] });
db.orm.Project.where((p, { fns }) => fns.has(p.tags, 'ydb').buildAst());
db.orm.Project.where((p, { fns }) =>
  fns.hasSome(p.tags, ['ydb', 'other']).buildAst(),
);
db.orm.Project.where((p, { fns }) =>
  fns.hasEvery(p.tags, ['prisma', 'ydb']).buildAst(),
);
db.orm.Project.where((p, { fns }) => fns.isEmpty(p.tags).buildAst());
```

Use `fns` in rc.18: list field methods are not exposed. Needles compare in the
element's JSON form. The pinned ORM's function-condition type hardcodes a
PostgreSQL boolean codec; `.buildAst()` passes the native expression through its
supported `WhereArg` overload without a cast.
`hasSome([])` is false, `hasEvery([])` is true and `isEmpty()`
is true for `[]`. SQL NULL propagates. Scalar-column `in([...])` still uses a
native YQL list parameter and is distinct from list-column storage.

## Relations

See [Relations and referential integrity](relations.md) for application protocols,
deletion policies and concurrency examples.

For PSL, opt into `relationMode: 'application'` in `defineYdbConfig` and use
ordinary `@relation(fields: [...], references: [...])`. The official namespace
authoring hook retains query relations and indexes while omitting physical FKs
before contract hashing. Action-bearing relations retain client-side metadata:
`onDelete: Cascade | SetNull | Restrict` is supported; NoAction-only declarations
are rejected (use Restrict). `onUpdate` supports NoAction/Restrict only. Raw YQL
bypasses these checks. Relations without actions remain unenforced query metadata.
TypeScript contracts use `constraint: false`, because YDB does not enforce foreign
keys. Includes lower to native grouped joins and typed lists/structs. They support
to-many and optional to-one relations, nested includes, composite equality keys,
child filters, and per-parent ordering/offset/limit. `some`, `none` and `every`
lower to key-membership queries. Relation reducers and `combine()` can return
child rows and aggregates together.

For a contract with a `Parent.children` relation:

```ts
await db.orm.Parent.where((parent) =>
  parent.children.some((child) => child.value.gt(2)),
)
  .include('children', (child) =>
    child.combine({
      rows: child.orderBy((row) => row.value.desc()).limit(2),
      total: child.count(),
      max: child.max('value'),
    }),
  )
  .orderBy((parent) => parent.id.asc())
  .all();
```

Empty child groups decode as `[]`, a missing optional to-one relation as `null`,
`count()` as `0`, and nullable reducers such as `sum()`/`max()` as `null`.

Each child group is aggregated before joining, preserving parent cardinality and
pagination. This can scan a broad child input; no load/performance qualification
has been performed. Distinct/grouped/locked row includes, non-equality or
disjunctive correlation keys, and references across multiple query levels are
rejected explicitly. There is no alternate query-based relation strategy here.
Many-to-many and self-relations have not been independently validated.

## Schema and migrations

`defineYdbConfig` supplies native descriptors to the official Prisma CLI.
Edit the `.prisma` source, run `prisma migration plan --name change`, review
the generated migration, then run `prisma db migrate`. Use `prisma migration
check` for offline validation and `prisma db verify` for live schema validation.
The example workspace exposes these through `yarn db:*` scripts; see
[migrations](migrations.md). Commit migrations and snapshots; regenerate the client.

The native planner handles create/drop tables, column add/drop, supported default
and nullability changes, and synchronous indexes. Each DDL statement has an
expected before/after table shape. It refuses unsafe automatic primary-key/type
reconstruction, unsupported schema features and unrecognized drift. Use a
dedicated database for the managed contract; unrelated tables are not silently
accepted during final schema verification.

Unique indexes can be created with a new table. Adding a unique index to an
existing table is rejected on the pinned YDB version. Numeric TTL/tiering, column tables,
covering or asynchronous indexes and indexes still being built are not silently
converted to ordinary row-table contracts. Partitioning and replica settings are
operational configuration outside the schema model.

YDB DDL is not transactional. The runner uses four control tables:

- `_prisma_marker`: the verified contract storage/profile hashes.
- `_prisma_ledger`: applied migration edges.
- `_prisma_ydb_migrations`: statement hashes and per-operation journal.
- `_prisma_ydb_lock`: exclusive migration owner, acquisition time, host and PID.

A failed migration can leave DDL applied while the marker remains unchanged.
Retry the unchanged migration: already-applied steps are recognized by their
journal and live schema. A checksum mismatch or unexpected table shape stops the
run. Before/after checkpoints inspect only the operation's target table; final
destination verification still checks the full schema. Full introspection shares
one TableService session and bounds concurrent table descriptions to eight.
Data destruction is subject to the Prisma migration policy.

Reviewed data transformations use `ydbDataOperation`: the DML, a verification
query returning one boolean `ok = true` row, and the journal entry commit in one
Serializable transaction. Custom DDL uses `ydbSchemaOperation` with explicit
before/after shapes. Migration authoring and recovery examples are in
[the migration guide](migrations.md).

Control-table setup upgrades an existing lock table by adding only missing
nullable `acquired_at Timestamp`, `host Utf8` and `pid Uint32` columns. A
concurrent upgrade is accepted after re-describing the table. Lock contention
reports owner, host, PID, acquisition time in ISO format and age; older lock
rows without metadata report unknown values.

An interrupted process can leave a persistent lock. After checking that the
original deployer is stopped and inspecting the journal/live schema, release
only the recorded owner using `releaseYdbMigrationLock(controlDriver, owner)`.
A different owner is rejected. This is an explicit operator recovery operation;
locks never expire automatically during a potentially long DDL operation.

```ts
import { YdbDriver } from 'prisma-ydb/driver';
import { YdbControlDriver, releaseYdbMigrationLock } from 'prisma-ydb/control';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

const native = new YdbDriver();
try {
  await native.connect(ydbBindingFromEnv());
  // Supply the exact owner reported by the failed deployment after investigation.
  await releaseYdbMigrationLock(new YdbControlDriver(native), recordedOwner);
} finally {
  await native.close();
}
```

## Compatibility boundaries

Unsupported operations produce explicit errors. Current boundaries include:

- No database foreign keys or CHECK constraints; relation metadata must use
  `constraint: false` in TypeScript authoring, or explicit PSL `relationMode: 'application'`. Database cascades are not available.
- No SQL namespaces, native SQL array columns (lists are stored as Json), native enum types, partial/expression indexes,
  `DISTINCT ON`, LATERAL joins or row locking clauses.
  String enums are supported as client types and accessors over `Utf8` columns.
- Upsert uses primary keys with distinct create/update branches. Non-primary
  conflict targets and conflict-skipping bulk inserts are rejected.
- Repeated junction `connect` that relies on swallowing a duplicate insert is
  unsupported: a YDB query failure invalidates the transaction, so it cannot
  continue to commit as if a savepoint had recovered that insert.
- ORM `createAll()` groups rows by supplied fields and can apply omitted defaults.
  A manually constructed heterogeneous SQL-lane INSERT with per-row `DEFAULT`
  expressions is rejected.
- `@default(now())` is rejected; use native `temporal.*` presets. Literal storage defaults, UUID/ULID and other
  supported runtime ID generators are separate from database clock defaults.
- Serial/BigSerial storage defaults are allowed only in primary keys. Sequence
  values can be consumed by failed/rolled-back inserts, as documented by YDB.
- Automatic table rebuilds and cross-space atomic DDL are not provided.
- Contract printing currently rejects relations/custom model metadata it cannot
  preserve. Database inference cannot recover relation metadata without foreign
  keys; retain the authored contract as the source of truth.

TLS and credentials use `binding.driverOptions` from the official SDK. The env
helper supports access tokens, static credentials, metadata credentials, custom
CA and client certificates. Detailed server issues are opt-in via
`includeServerIssues`; they may contain application data. The default error and
`onEvent` output omit query text, parameter values and server issue text.

SDK 6.3.1 routes session RPCs with a preferred-node hint. The server session ID
remains authoritative. Low-level transaction handles are not recreated or
replayed; whole-callback retries require the explicit option described above.
Multi-node failover, packet loss, ambiguous commit recovery and
sustained load have not been validated for this extracted release. The opt-in `yarn test:integration` suite verifies UUID/prepared execution and
managed partition/changefeed migration lifecycles on an explicitly selected
disposable database.

## Official references

- [Prisma ORM API at the pinned tag](https://github.com/prisma/orm/blob/v8.0.0-rc.18/packages/3-extensions/sql-orm-client/README.md)
- [YDB JavaScript SDK](https://github.com/ydb-platform/ydb-js-sdk)
- [YDB transactions](https://ydb.tech/docs/en/concepts/transactions)
- [YQL CREATE TABLE](https://ydb.tech/docs/en/yql/reference/syntax/create_table/)
- [YQL primitive types](https://ydb.tech/docs/en/yql/reference/types/primitive)
- [YDB serial types](https://ydb.tech/docs/en/yql/reference/types/serial)
- [Local YDB Docker configuration](https://ydb.tech/docs/en/reference/docker/configuration)
