# Transactions, retries and cancellation

`db.transaction(callback)` opens one native YDB Serializable read-write
transaction. `tx.orm`, `tx.sql`, `tx.raw`, `tx.query`, `tx.execute`, `tx.yql` and
`tx.queryYql` share its session and transaction ID. Successful callbacks commit;
exceptions trigger rollback.

```ts
await db.transaction(
  async (tx) => {
    const project = await tx.orm.Project.create({ name: 'Release' });
    await tx.orm.Task.create({
      title: 'Publish',
      createdAt: new Date(),
      projectId: project.id,
    });
  },
  { retry: true },
);
```

Use `tx` inside the callback. A query through the root `db` runs separately and
will not roll back with this transaction.

`{ mode: 'snapshotReadOnly' }` opens a snapshot read-only transaction instead:
every read in the callback sees one consistent snapshot, it never conflicts with
concurrent writers (so it is never aborted by them), and the server rejects any
write issued through it. Use it for multi-statement reports and consistency checks. Await the operations you start and do
not retain the transaction handle after the callback settles.

## Round trips

The server transaction begins with the callback's first statement (`beginTx` in
its transaction control), not with a separate BeginTransaction RPC, and the
driver commits with one CommitTransaction RPC after the callback returns. A
callback of N statements therefore costs N + 1 round trips; a callback that
issues no statements costs none. Rollback of a transaction that never reached
the server is also local.

A native statement can carry the commit itself. Set `commit: true` on the last
`tx.queryYql` request to fold the commit into that round trip:

```ts
import { Text } from 'prisma-ydb/runtime';

await db.transaction(async (tx) => {
  const [project] = await tx.orm.Project.where({ id }).select('name');
  await tx.queryYql({
    text: 'DECLARE $id AS Utf8; UPDATE `Project` SET archived = TRUE WHERE id = $id',
    parameters: { id: new Text(id) },
    commit: true,
  });
  return project;
});
```

For a final ORM, SQL-builder or prepared statement, use `tx.commitWith`:

```ts
await db.transaction(async (tx) => {
  const project = await tx.orm.Project.where({ id }).first();
  await tx.commitWith(() =>
    tx.orm.Project.where({ id }).updateAll({ archived: true }),
  );
  return project;
});
```

A direct first statement in the thunk carries `commitTx`, reducing N + 1 RPCs
to N. Single-statement writes such as `create` without nested relations,
`createAll`, `updateAll`, `deleteAll`, `updateAndCount`, `deleteAndCount` and
`upsert`, as well as native YQL, can use this path.

ORM mutation scopes never carry `commitTx` on an individual statement. This
includes `update()` or `delete()` on unique filters, nested mutation graphs and
multi-table inheritance writes. `commitWith` waits for the entire scope and
then sends a normal commit RPC, preserving atomicity without saving a round trip.

A thunk with no statements rejects locally. A second direct statement rejects
before it is sent; when the first direct statement already committed, that
commit cannot be undone. A direct statement after scoped statements also
rejects. Await the thunk's database work before returning, and do not start
other transaction work concurrently with it.

After a statement-level commit, the transaction accepts no further statements:
the callback's own commit becomes a no-op, more queries through `tx` fail, and a
callback exception no longer rolls anything back or triggers a retry. A failed
`commit: true` statement with an uncertain status is `outcomeUnknown`, exactly
like a failed CommitTransaction.

A handle created by `db.prepare(...)` can query this transaction with
`prepared.query(tx, params)`. Its execution uses the held transaction and the
same runtime validation and middleware as ordinary ORM queries. Do not retain
`tx` after settlement; prepared calls reject it as well.

## Callback retries

Callbacks run once by default. `{ retry: true }` permits five total attempts;
`{ retry: { maxAttempts: 3 } }` permits three. Each retry repeats the **entire
callback**, including reads and writes, on a fresh connection.

| Failure                                              | Callback retry behavior                   |
| ---------------------------------------------------- | ----------------------------------------- |
| `ABORTED`, including at commit                       | Retry when enabled                        |
| Other retryable server failure, such as `OVERLOADED` | Retry with backoff                        |
| Application error or transaction timeout             | Return the error                          |
| Transport error or `outcomeUnknown`                  | Return the error without automatic replay |
| Commit acknowledged, subsequent cleanup fails        | Never repeat the callback                 |

Retries use capped exponential backoff with full jitter. Delay settings come
from `driverOptions.retry`: `baseDelayMs: 10`, `maxDelayMs: 1000`,
`overloadedBaseDelayMs: 200`, `overloadedMaxDelayMs: 5000`. The callback attempt
limit comes from `transaction(..., { retry })`, separately from driver
`maxAttempts`. If driver retries are disabled, explicitly enabled callback
retries use the default delays.

The backoff pause between callback attempts holds no session. `db.close()`
interrupts it: the pending transaction rejects with a connection error instead
of attempting another replay.

External effects inside a callback can happen more than once. Email delivery,
external payments and message publication need their own replay-safe protocol.
For durable event delivery, an application can write an outbox record in the
same transaction and publish it through a separate worker. The library does not
provide an outbox implementation.

## An unknown commit outcome

A network error around commit does not prove rollback: the server may have
committed without the client receiving its acknowledgement. Errors marked
`outcomeUnknown` are never automatically replayed. Reconcile the operation using
a previously chosen operation ID and the stored result before deciding what to
do next. Cancelling an RPC also does not establish that commit never happened.

A unique operation key and a stored result can form part of your application's
idempotency protocol. `retry: true` alone does not provide exactly-once execution.

## Automatic retries for individual queries

Outside an interactive transaction, the driver retries eligible failures.
Compiler-tagged SELECTs use `snapshotReadOnly` by default. Native YQL defaults to
Serializable, even if its text starts with SELECT. Explicitly choose
`transactionMode: 'snapshotReadOnly'` for a read-only native request.

`idempotent: true` allows retries for additional server statuses and transport
failures. It is a caller assertion that replay is safe; the driver cannot infer
the business meaning of the query. Errors explicitly marked `outcomeUnknown`
still never retry. Disable replay for a request with `retry: false`, or for the
driver with `driverOptions.retry: false`.

Native streaming stops retrying after its first yielded part, avoiding duplicate
delivery of rows. Statements inside an interactive transaction do not retry
individually. A conflict requires replaying the whole transaction. See the
[API retry classification](api.md#driver-options-and-retries) for status details.

## Error classification and autocommit retry helper

`classifyYdbError(error)` follows `cause` chains and the primary (first) error in
transaction `AggregateError` wrappers. It returns `kind`, optional YDB `status`,
`outcomeUnknown`, `retryable`, `retryableIfIdempotent`, `uniqueViolation`, and an
optional `ensure: { message }`. Kinds distinguish unique constraints, authored
Ensure failures, referential guards, conflicts, overload, unavailability,
sessions, transport, timeout, cancellation, other query failures and unknown
errors. Unknown application errors and cancellation are never replayed.

On local YDB 26.2, failed YQL `Ensure` returns `PRECONDITION_FAILED` (400120),
without issue codes. This status alone does not identify Ensure or uniqueness.
The normalizer recognizes the observed Ensure envelope and keeps only the
authored message, including multiline text; `ensure` is absent when
Ensure has no message. It omits server diagnostics and the underlying cause
unless `includeServerIssues` is enabled. Unique violations require the observed
duplicate-key issue, and `YDB.REFERENTIAL_ACTION` remains a referential error.

For autocommit application work, use `withRetry` from `prisma-ydb/runtime` or
`prisma-ydb/driver`:

```ts
const result = await withRetry(
  (signal) => db.queryYql({ text, parameters, signal, retry: false }),
  {
    budgetMs: 5000,
    maxAttempts: 3,
    idempotent: true,
    onRetry: ({ attempt, delayMs }) => log({ attempt, delayMs }),
  },
);
```

The function receives a signal covering caller cancellation and the total time
budget. Forward it to in-flight work. The budget includes attempts and full-jitter
backoff; cancellation interrupts sleep. Five total attempts and the driver delay
defaults apply unless overridden. Delay options may be supplied directly or in
`retry`. `onRetry` runs before backoff and reports the next attempt (starting at
2). No replay follows an unknown outcome or a non-retryable error. Exhaustion or
cancellation after a failed attempt rethrows the last failure; before a failure,
cancellation returns its reason and budget exhaustion raises `TimeoutError`.
The helper cannot stop external work that ignores its signal. Use it around
autocommit operations, and use `db.transaction(..., { retry })` to replay complete
transaction callbacks.

## Timeouts and cancellation

| Option                 | Default    | Budget                                     |
| ---------------------- | ---------- | ------------------------------------------ |
| `acquireTimeoutMs`     | 10 seconds | Waiting for a session                      |
| `queryTimeoutMs`       | 30 seconds | A query, including its retries             |
| `transactionTimeoutMs` | 60 seconds | One callback attempt                       |
| `closeTimeoutMs`       | 30 seconds | Runtime drain and driver shutdown together |

Transaction timeout cancels in-flight YQL before rollback. `tx.signal` also lets
you propagate cancellation into external work. JavaScript cannot forcibly stop
an arbitrary callback that ignores the signal: it may keep executing after the
timeout, but further queries through the settled transaction are rejected.
Individual `queryYql` requests accept `signal` and `timeoutMs`.

The transaction budget applies per attempt. Account for multiple attempts and
backoff when setting a request-level deadline. `db.transaction` currently has
no caller-supplied `signal` option.

## Transaction boundaries

Nested transactions, savepoints and alternative callback isolation levels are
unsupported. A session serializes its statements; `Promise.all` inside a
transaction does not create parallel server transactions.

Nested ORM mutation graphs share the outer transaction. A failed graph
invalidates it even if the callback catches the exception, preventing a partial
graph from committing. Start a new transaction for independent work after such
a failure.

A callback holds its pool session for its full duration. Avoid long external
network calls inside it. `driverOptions.maxTransactionSessions` caps how many
sessions callbacks, Prisma mutation graphs and explicit connections may hold at
once (default: `maxSessions`); the remainder stays available to autocommit
statements, and `db.stats().held` reports the current count. Callbacks beyond the
cap wait in the acquisition queue like any other lease.

Transactions make your chosen operations atomic. Reference checks and deletion
rules still belong to the application; see [relations](relations.md).

Official references: [YDB transactions](https://ydb.tech/docs/en/concepts/transactions),
[YDB status codes](https://ydb.tech/docs/en/reference/ydb-sdk/ydb-status-codes).
