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
| `prisma-ydb/control`     | Native schema and migration components                    |
| `prisma-ydb/environment` | `ydbBindingFromEnv` for SDK auth/TLS conventions          |

The root export contains the runtime factory and low-level driver. Control-plane
code is also available through an explicit subpath. Generated contracts are
consumed through the package's YDB contract serializer.

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

`db.transaction(async tx => ...)` provides `tx.orm`, `tx.sql`, `tx.raw`,
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

`db.prepare(declaration, callback)` uses Prisma's prepared plan API: compilation
and result-decoder setup are reused, while each call binds and validates values.
It does not expose a server-side prepared statement handle or native cache policy.

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

## Type mapping

| Contract scalar | YDB storage     | JavaScript                                 |
| --------------- | --------------- | ------------------------------------------ |
| `String`        | `Utf8`          | `string`                                   |
| `Int`           | `Int32`         | checked integer `number`                   |
| `BigInt`        | `Int64`         | range-checked `bigint`                     |
| `Uint64`        | `Uint64`        | range-checked unsigned `bigint`            |
| `Boolean`       | `Bool`          | `boolean`                                  |
| `Float`         | `Double`        | finite `number`                            |
| `DateTime`      | `Timestamp`     | `Date`; truncates to milliseconds          |
| `Json`          | `Json`          | JSON values, including scalar strings/null |
| `Bytes`         | binary `String` | `Uint8Array`                               |
| `Decimal`       | `Decimal(22,9)` | exact decimal `string`                     |

ORM Timestamp decoding, including relation includes, truncates microseconds to
milliseconds. Writes remain millisecond-exact JavaScript `Date` values. Native
relation formatting preserves fractional seconds before ORM decoding.
Raw Timestamp values preserve microseconds as `bigint`. Raw Decimal values
preserve exact decimal strings; native `DecimalValue` accepts explicit precision
and scale up to YDB's precision limit of 35. Non-finite decimals and nonzero
digits beyond the requested scale are rejected. Aggregate `count()` and integer `sum()` reject
unsafe number conversion; use the bigint variants for larger values. SQL array
columns are unsupported; native YQL list/struct parameters remain available.
The pinned Prisma SQL-family validator rejects a non-nullable `Json` field with
a literal JSON-null storage default. Nullable JSON defaults can represent JSON
null; use native wire mode when the distinction from SQL NULL must be inspected.

## Relations

See [Relations and referential integrity](relations.md) for application protocols,
deletion policies and concurrency examples.

For PSL, opt into `relationMode: 'application'` in `defineYdbConfig` and use
ordinary `@relation(fields: [...], references: [...])`. The official namespace
authoring hook retains query relations and indexes while omitting physical FKs
before contract hashing. The application owns referential integrity; raw YQL
can bypass its checks. Explicit `onDelete`/`onUpdate` actions are rejected rather
than ignored. Persisted contracts with physical FKs are still rejected.
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
existing table is rejected on the pinned YDB version. TTL/tiering, column tables,
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
- No SQL namespaces, array columns, native enum types, partial/expression indexes,
  `DISTINCT ON`, LATERAL joins or row locking clauses.
- Upsert uses primary keys with distinct create/update branches. Non-primary
  conflict targets and conflict-skipping bulk inserts are rejected.
- Repeated junction `connect` that relies on swallowing a duplicate insert is
  unsupported: a YDB query failure invalidates the transaction, so it cannot
  continue to commit as if a savepoint had recovered that insert.
- ORM `createAll()` groups rows by supplied fields and can apply omitted defaults.
  A manually constructed heterogeneous SQL-lane INSERT with per-row `DEFAULT`
  expressions is rejected.
- `@default(now())` is rejected. Literal storage defaults, UUID/ULID and other
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
sustained load have not been validated for this extracted release. This extracted project currently has no automated driver regression suite.

## Official references

- [Prisma ORM API at the pinned tag](https://github.com/prisma/orm/blob/v8.0.0-rc.18/packages/3-extensions/sql-orm-client/README.md)
- [YDB JavaScript SDK](https://github.com/ydb-platform/ydb-js-sdk)
- [YDB transactions](https://ydb.tech/docs/en/concepts/transactions)
- [YQL CREATE TABLE](https://ydb.tech/docs/en/yql/reference/syntax/create_table/)
- [YQL primitive types](https://ydb.tech/docs/en/yql/reference/types/primitive)
- [YDB serial types](https://ydb.tech/docs/en/yql/reference/types/serial)
- [Local YDB Docker configuration](https://ydb.tech/docs/en/reference/docker/configuration)
