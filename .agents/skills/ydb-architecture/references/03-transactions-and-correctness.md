# 03. ACID, Consistency, Idempotency, and Failure Handling

## Choose the transaction mode intentionally

**Default to Serializable for strict business-state mutations.** YDB uses optimistic concurrency control; conflicts on observed state can abort a transaction. Successfully committed Serializable transactions are serializable. YDB documents linearizability guarantees per key; do not extrapolate those guarantees into universal wall-clock ordering of every independent key.

| Mode | Typical use | Do not assume |
|---|---|---|
| `Serializable` | Critical read-modify-write, interdependent invariants | Zero conflicts or zero-cost distributed commit |
| `Snapshot Read-Write` | Workloads where snapshot isolation is sufficient | Automatic prevention of write skew |
| `Snapshot Read-Only` | Consistent reports or snapshot reads | Visibility of commits later than the snapshot |
| `Stale Read-Only` | Lookups that explicitly tolerate staleness | Up-to-date values, strict ordering between SELECTs, applicability to all OLAP paths |

Treat `Online Read-Only` as a legacy mode; do not select it for new designs without version-specific justification. Verify the SDK's exact mode names and semantics.

## Bound transaction duration and size

- Define the **minimum set of entities** that must change in one atomic commit to preserve business invariants.
- Never call external HTTP/RPC services, send emails, operate on remote S3, or wait for user actions while a DB transaction is open.
- Large fan-out, non-key queries, table scans, many SYNC indexes, and touching numerous shards increase coordination costs and conflict probability.
- Whenever possible, perform required reads **before the first modifications**. Read-after-write can force YDB to flush pending changes to shards earlier than expected.
- Never migrate an entire historical dataset in one transaction. Use bounded batches, stable cursors, durable progress checkpoints and restartable operations.
- DDL and DML have different semantics. Do not assume multiple schema-changing statements are atomically committed as a standard DML transaction.

## Reliable registration of a once-only command

For commands that must not apply twice (quota deduction, payment creation, resource allocation, irreversible message processing):

1. Assign a **stable `commandId`** in the client or producer. A retry must reuse the same ID **and the same intent**, rather than generating a new UUID.
2. Use a durable receipt/evidence table uniquely keyed by the command identity. If the PK is composite, the entire key must be deterministic from the command. Store a request fingerprint or material parameters to detect reuse of an ID with changed input.
3. Within one Serializable transaction: read receipt → when it exists, verify request identity and return the recorded outcome → otherwise check invariants → modify authoritative state → add immutable event/ledger where needed → **INSERT** receipt → commit.
4. Concurrent copies of one command must conflict on the same uniqueness record and/or serializable read/write dependency. After conflict, retry the **entire transaction** and return the already-committed outcome. Never allow two successful commits of the same command.
5. If commit outcome is unknown, resolve it using the durable receipt under appropriate consistency, instead of repeating the external or irreversible effect under a new ID.
6. Retention for receipts must be deliberate: deleting evidence via TTL can permit future duplicate execution. If receipts expire, reject commands older than the permitted replay window or keep separate permanent uniqueness evidence.

**`UPSERT` is not a uniqueness claim.** With an existing PK it can update the row. For once-only registration, use `INSERT` with the proper conflict behavior or a rigorously proven compare-and-swap/state-machine protocol. A conditional UPDATE does not establish uniqueness for *new* commands.

## Enforcing invariants without FKs and triggers

- **Parent/child existence:** reading “parent exists” in a separate transaction is insufficient. Coordinate concurrent create/delete using a Serializable protocol that reads/writes the relevant shared key; define deletion restrictions or tombstones. Do not promise automatic PostgreSQL CASCADE semantics.
- **State transitions:** for status columns stored as `Utf8` or integers, define allowed transitions explicitly. Use conditional updates constrained by prior status/version and assert the actual updated-row count.
- **Uniqueness:** enforce via PK, a supported unique index, or an atomically maintained key-mapping table. A standalone existence check before a later commit is vulnerable to races.
- **Aggregate invariants:** Snapshot RW alone does not prevent all write-skew anomalies. Use Serializable and a deliberate common conflict key where necessary.
- **Transfers or changes spanning two owners:** use deterministic ordering for access to shared resources where relevant. YDB OCC may still abort one of the concurrent transactions; preserve conservation of value and ownership rather than assuming conflicts can be eliminated.

## Retries and uncertain commit outcomes

Handle each status according to documented SDK and operation semantics:

- **`ABORTED` or invalidated transaction state:** recreate the transaction context and retry **all its reads, checks, and writes**.
- **`OVERLOADED` / `UNAVAILABLE`:** use bounded retries, backoff with jitter, deadlines, backpressure, and concurrency reduction as appropriate; avoid retry storms. Do not assume every failed statement is automatically retryable.
- **`UNDETERMINED`:** the atomic commit outcome is **unknown**. Neither success nor failure is established. Reconcile via the stable receipt/unique command ID and only then safely retry the identical operation if needed.
- **Schema, validation, authorization or deterministic payload errors:** do not retry indefinitely; correct the underlying cause.

External side effects require a separate reliable protocol: transactional topic or outbox, stable `eventId`, at-least-once redelivery handling, an idempotent consumer and compensating/recovery actions as needed. “Commit DB → call HTTP → hope it worked” without persisted execution state is not a sufficient design.

### Logical flow (pseudocode; NOT an SDK API)

```text
executeCommand(requestId, payload):
  boundedRetrySerializable:
    tx = begin()
    old = tx.readReceipt(requestId)
    if old exists:
      assertSameIntent(old.fingerprint, payload)
      return old.result
    entity = tx.readEntity(payload.entityId)
    assertBusinessPreconditions(entity, payload)
    newState = computeNextState(entity, payload)
    tx.conditionalWriteEntity(newState, expectedVersion=entity.version)
    tx.insertReceipt(requestId, fingerprint(payload), newState.result)
    tx.insertEvent(payload.entityId, requestId, newState)
    tx.commit()
    return newState.result
  on UNDETERMINED:
    requery receipt; never create a new requestId for the retry
```

If a conditional write affects fewer rows than expected, **do not continue toward commit**. Diagnose missing state vs. a concurrent modification vs. a business rejection, and retry the entire transaction where appropriate.

## Required correctness and resilience tests

- N concurrent requests with one `commandId` produce exactly **one committed business effect**.
- Reusing one `commandId` with a different payload yields an intent conflict, not a second execution.
- Two mutually exclusive state transitions competing concurrently produce exactly one winner.
- An injected error after an authoritative-state change but before receipt creation rolls back **both** changes.
- A timeout immediately before or during commit is reconciled through the receipt without duplicate execution.
- A consumer processing the same event twice leaves the final state unchanged.
- Delayed index, replica or CDC state never influences a decision that requires current authoritative data.
- Concurrent parent deletion and child creation cannot break relationship invariants.
- High contention is measured: retries/sec, abort rate, p95/p99, hot shards and write amplification.
