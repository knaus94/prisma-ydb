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
will not roll back with this transaction. Await the operations you start and do
not retain the transaction handle after the callback settles.

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
network calls inside it. Enough slow callbacks can occupy the entire pool;
there is currently no separate reservation for autocommit traffic.

Transactions make your chosen operations atomic. Reference checks and deletion
rules still belong to the application; see [relations](relations.md).

Official references: [YDB transactions](https://ydb.tech/docs/en/concepts/transactions),
[YDB status codes](https://ydb.tech/docs/en/reference/ydb-sdk/ydb-status-codes).
