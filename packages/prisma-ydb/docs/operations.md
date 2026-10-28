# Configuration, health and operations

Create one client per application process. Call `connect()` during startup and
`close()` during shutdown. Reusing a client reuses discovery, connections and the
session pool. See [NestJS integration](nestjs.md) for lifecycle hooks.

## Endpoint, credentials and TLS

```ts
import { ydb } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

const db = ydb<Contract>({
  contractJson,
  binding: ydbBindingFromEnv(),
  driverOptions: { minSessions: 2, maxSessions: 16 },
});
```

`YDB_CONNECTION_STRING` contains the endpoint and database path, for example
`grpc://localhost:2137/local` for the local example. Use your cluster's `grpcs://`
endpoint and database path for TLS. The helper does not load `.env` itself:
load it in the application, for example with `import 'dotenv/config'`.

The helper delegates credentials and TLS to `@ydbjs/auth`'s environment provider.
The pinned provider checks credential modes in this order:

| Environment setting                                                 | Mode               |
| ------------------------------------------------------------------- | ------------------ |
| `YDB_ANONYMOUS_CREDENTIALS=1`                                       | Anonymous          |
| `YDB_METADATA_CREDENTIALS=1`                                        | Metadata service   |
| `YDB_ACCESS_TOKEN_CREDENTIALS`                                      | Access token       |
| `YDB_STATIC_CREDENTIALS_USER` and `YDB_STATIC_CREDENTIALS_PASSWORD` | Static credentials |

Select one mode deliberately. Keep credentials outside source control. Configure
custom CA with `YDB_SSL_ROOT_CERTIFICATES_FILE` or inline
`YDB_SSL_ROOT_CERTIFICATES`; `NODE_EXTRA_CA_CERTS` is also supported by the
provider. Client TLS credentials use `YDB_SSL_CERTIFICATE_FILE` and
`YDB_SSL_PRIVATE_KEY_FILE`, or their inline variants `YDB_SSL_CERTIFICATE` and
`YDB_SSL_PRIVATE_KEY`. Do not set a file and its inline counterpart together.

For programmatic SDK configuration, use `binding.driverOptions`. This is the
SDK's configuration; top-level `driverOptions` configures this library's pool,
query limits and retry behavior.

## Pool and limits

| Option                   | Default            | Meaning                                                                     |
| ------------------------ | ------------------ | --------------------------------------------------------------------------- |
| `maxSessions`            | `16`               | Maximum active pool sessions                                                |
| `minSessions`            | `0`                | Best-effort warmup during connect; must not exceed maximum                  |
| `maxTransactionSessions` | `maxSessions`      | Cap on sessions held across statements (transactions, explicit connections) |
| `maxWaiters`             | `128`              | Admission queue capacity                                                    |
| `acquireTimeoutMs`       | `10000`            | Maximum session wait                                                        |
| `sessionMaxIdleMs`       | `300000`           | Retirement of idle sessions above the warm minimum                          |
| `sessionMaxAgeMs`        | `3600000`          | Retirement of aged sessions                                                 |
| `sessionCloseTimeoutMs`  | `2000`             | DeleteSession RPC budget                                                    |
| `queryTimeoutMs`         | `30000`            | Query deadline, including retries                                           |
| `transactionTimeoutMs`   | `60000`            | One interactive transaction attempt                                         |
| `closeTimeoutMs`         | `30000`            | Shared runtime/driver shutdown deadline                                     |
| `maxResultRows`          | `100000`           | Result row limit                                                            |
| `maxResultBytes`         | `33554432`         | Estimated result size limit                                                 |
| `readTransactionMode`    | `snapshotReadOnly` | Compiler-tagged reads outside interactive transactions                      |
| `statsMode`              | `none`             | Native query statistics; `basic` is opt-in                                  |
| `includeServerIssues`    | `false`            | Include detailed server issues in error causes                              |

Unknown keys and invalid values are rejected. Size the pool against measured
latency, database capacity and application concurrency. Each native session has
an attach stream; larger pools also increase transport resource usage. Queue
rejection is deliberate load shedding. Slow transaction callbacks hold sessions
for their whole duration; `maxTransactionSessions` limits held leases so the
remaining pool capacity stays available to autocommit statements.

Session age/idle retirement provides turnover; it is not a promise that active
transactions migrate between nodes. Active transactions remain attached to their
session. Recovery may require an explicitly enabled whole-callback retry.

The result-size bound is an estimate, not an exact process-memory budget.
Buffering many concurrent results can use much more memory than one request's
limit. Prefer bounded pages and measured limits for your workload.

## Readiness

```ts
const health = await db.health({ timeoutMs: 1000 });
if (!health.ready) {
  // Return HTTP 503 from the application's readiness endpoint.
}
console.log(health.state, health.pool, health.latencyMs);
```

Health never implicitly connects and returns a result instead of throwing. Its
states are `unbound`, `connecting`, `connected`, `closing` and `closed`. A
connected client performs `SELECT 1` in a snapshot read-only transaction without
retries. Other states return `ready: false` without an RPC. The default probe
budget is the smaller of five seconds and `queryTimeoutMs`; a caller signal can
cancel it.

Readiness becomes false as soon as client shutdown starts, including while the
runtime is draining or an earlier probe is still completing. A successful probe
confirms query connectivity, not schema correctness or every application
invariant. Run `prisma db verify` during deployment for managed schema validation.

## Metrics and diagnostics

`db.stats()` returns `maxSessions`, `idle`, `leased`, `held`, `creating`,
`waiters` and `closing`. The low-level driver exposes the same snapshot through
`driver.stats`. `held` counts leases obtained through `acquireConnection()`
(interactive transactions and explicit connections); `closing` counts background
cleanup operations.

The snapshot also includes `paths.autocommit`, `paths.streaming`,
`paths.bulkUpsert` and `paths.held`, each with `active`, `total` and `errors`.
Counters are cumulative for this driver instance; snapshots are independent
copies. Autocommit counts buffered native and ORM requests, streaming counts
native streams and `db.streaming`, and bulk writes count each low-level upload
chunk. Retries stay within one logical request. `active` includes acquisition
and backoff for these request paths; a stream remains active until consumed or
returned. `paths.streaming.abandoned` counts early consumer returns separately
from thrown failures, which increment `errors`. Health probes use autocommit.

For `held`, `total` counts explicit lease acquisition attempts, `active` counts
successfully acquired leases until return, and `errors` counts failed
acquisitions or returned leases with a failed operation or discarded session,
once per lease. It includes interactive transactions, Prisma mutation graphs
and explicit connections. Root ORM mutations that acquire such a lease are
counted under `held`. Use its active level and total/error deltas together with
`waiters` to tune `maxTransactionSessions`; do not add path counters together as
though they all counted individual statements. Counter updates reuse fixed
objects; copies are created only when a snapshot is requested.

```ts
const db = ydb<Contract>({
  contractJson,
  binding: ydbBindingFromEnv(),
  driverOptions: {
    onEvent(event) {
      // Forward durationMs, success, operation, status and pool to your metrics sink.
      console.log(event);
    },
  },
});
```

Events cover connect, acquire, session-create, query, begin, commit, rollback,
destroy, bulk-upsert and driver retry. Retry events include the next attempt number. `begin`
is a local event: the server transaction starts with the first statement.
`commit` and `rollback` of a transaction without server statements are local as
well. After a statement-level commit, `db.transaction` skips the final commit
entirely, so it produces no additional commit RPC or commit event. Repeated
`commit()` calls on a low-level committed handle remain local.
Whole-callback retry counting should be instrumented by the application; do not
assume a driver retry event covers every callback replay.

Events omit SQL, parameter values, credentials and server issue text. Keep the
callback lightweight. Detailed server issues are opt-in because error causes
can contain application data. Error classes expose structured status and outcome
information; avoid branching on message text.

## Shutdown

`close()` rejects new work and shares one `closeTimeoutMs` deadline between
Prisma runtime drain and native driver cleanup. If runtime drain exceeds the
budget, the client abandons remaining leases and reports a timeout. Repeated
calls return the same closing promise. Allow a longer process termination grace
period so shutdown can finish and its errors can be reported.

Do not interpret forceful client disposal as evidence that every in-flight
mutation rolled back. Reconcile unknown outcomes as described in
[transactions](transactions.md#an-unknown-commit-outcome).

## Deployment scope

Deploy reviewed migrations before serving code that requires their schema.
Keep one migration owner at a time. Follow the [recovery procedure](migrations.md#recover-an-interrupted-migration)
for a persistent migration lock; it is not automatically stolen after a timer.

The package pins a Prisma release candidate and specific YDB SDK packages. The
basic local example does not qualify all failure modes or sustained cluster
load. Validate your schema, credentials, query sizes and failure-recovery
requirements before deployment. There is currently no automated driver
regression suite in this extracted project.

Official references: [YDB JS SDK](https://github.com/ydb-platform/ydb-js-sdk),
[local YDB configuration](https://ydb.tech/docs/en/reference/docker/configuration).
