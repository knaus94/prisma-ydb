# Generic YDB Design Patterns (Application-Independent)

> These are **illustrative designs**, not automatically production-ready recipes. Before using them, verify YQL syntax, type compatibility, index semantics, expected access patterns, and the actual YDB version. Benchmark alternatives under the real workload.

## A. Append-only events by owner

**Workload:** many append-only writes from distinct owners; typical reads fetch only one owner's events in a bounded time range.

**Start here—do not introduce hashing without evidence:**

```sql
CREATE TABLE OwnerEvent (
    ownerId Uint64 NOT NULL,
    occurredAt Timestamp NOT NULL,
    eventId Utf8 NOT NULL,
    data JsonDocument,
    PRIMARY KEY (ownerId, occurredAt, eventId)
);
```

- `ownerId` first makes owner-bounded access efficient.
- `occurredAt` second maintains ordering within the owner's history.
- `eventId` third distinguishes events sharing a timestamp.
- Trade-off: one extremely hot owner can concentrate traffic in its key range. Measure hot shards before creating extra buckets.
- To obtain a global time-ordered stream of all events, use another access path or analytical facts rather than repeatedly scanning all of `OwnerEvent`.

**If write distribution across owners needs explicit spreading:**

```sql
CREATE TABLE OwnerEventBucketed (
    ownerHash Uint32 NOT NULL,
    ownerId Uint64 NOT NULL,
    occurredAt Timestamp NOT NULL,
    eventId Utf8 NOT NULL,
    data JsonDocument,
    PRIMARY KEY (ownerHash, ownerId, occurredAt, eventId)
);
```

Compute `ownerHash = deterministicHash(ownerId) % N` consistently in the application. This spreads **different owners**; it does not spread writes to the same owner's one mutable record. A future change to N is a migration.

## B. Strictly idempotent once-only command

**Workload:** a command can be retried over the network, but its business effect must happen at most once.

```sql
CREATE TABLE ProcessedCommand (
    commandId Utf8 NOT NULL,
    requestFingerprint Utf8,
    targetId Utf8,
    resultCode Utf8,
    committedAt Timestamp,
    PRIMARY KEY (commandId)
);

CREATE TABLE EntityState (
    entityId Utf8 NOT NULL,
    amount Int64,
    version Uint64,
    PRIMARY KEY (entityId)
);
```

**Protocol:** one Serializable transaction reads `ProcessedCommand`, validates the intent fingerprint, reads `EntityState`, checks the invariant, changes state, and **INSERTs** the receipt. Concurrent copies must either discover the committed receipt or receive a conflict that prompts a safe retry of the whole transaction. On an uncertain commit outcome, query the same `commandId` receipt.

**Anti-pattern:** unconditional `UPSERT INTO ProcessedCommand` for registering an immutable command, or doing existence checks and inserts in separate transactions.

## C. Lease-based worker queue

**Workload:** multiple workers claim tasks that must recover from worker crashes.

```text
Task:
  taskId (PK)
  status = READY | PROCESSING | DONE | FAILED
  leaseOwner
  leaseToken
  leaseUntil
  attempts
  updatedAt
```

- Atomically claim an available or expired task via a conditional READY/expired → PROCESSING transition. Validate the previous status, token/version and affected-row count.
- Only the **current** `leaseToken` is allowed to finalize work. A stale worker must not overwrite a later owner.
- A status/lease-expiry index or projection may discover candidate tasks. If this path is ASYNC, revalidate against the authoritative record during claim.
- External effects between claim and completion must be idempotent because an expired lease permits another worker to retry.
- TTL only terminal records after their required audit/replay retention period.

## D. High-contention counter

**Bad design:** every request updates one `GlobalCounter WHERE id = 'all'`, even though the cluster contains many servers. This creates a serialization hotspot.

**Alternative:** maintain multiple `CounterBucket(bucketId, total, version)` records, with writes allocated by a stable distribution strategy and incremented atomically.

**Cost:** a **strictly current total** needs a consistent snapshot or protocol spanning all buckets. A globally spendable finite budget additionally needs reservation, epoch or fencing logic to prevent stale aggregates from authorizing overspend. An eventual aggregate is insufficient for this purpose.

**Decision rule:** if strictly current correctness is essential and a multi-bucket protocol is not justified or provable, one serialized authoritative counter may be the safer choice. Scale across other independent entities instead.

## E. Analytical fact table

**Workload:** high-volume independent events and analysis by periods, dimensions and aggregates.

```sql
CREATE TABLE EventFact (
    tenantId Uint64 NOT NULL,
    occurredAt Timestamp NOT NULL,
    eventId Utf8 NOT NULL,
    eventType Utf8,
    value Int64,
    PRIMARY KEY (tenantId, occurredAt, eventId)
)
PARTITION BY HASH (tenantId, eventId)
WITH (
    STORE = COLUMN,
    AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 64
);
```

Distinguish both axes: PK controls sorting within COLUMN partitions, while `PARTITION BY HASH` spreads incoming rows. When a single tenant dominates traffic, including `eventId` in the distribution key may help, though queries scanning all tenant events still have a cost. The example is illustrative; confirm the DDL and selected partition count against the deployed version.

Typical pipeline: authoritative ROW data → CDC/topic → idempotent consumer or Transfer → batched COLUMN ingestion. Monitor pipeline lag, loss risk, checkpointing and backfill separately.

## F. Timeout and unknown commit result

**Scenario:** the client sends a command, and the network fails during COMMIT. Sending a new command with a new ID can create a duplicate effect.

**Safe response:**

1. Preserve the same `commandId` across all attempts, including producer restarts.
2. Treat `UNDETERMINED` as **unknown**, not as confirmed success or confirmed failure.
3. Read `ProcessedCommand` with a consistent authoritative read, not through an ASYNC projection.
4. If the receipt exists, validate the fingerprint and return its recorded outcome.
5. If it does not exist, retry the **entire** Serializable transaction with the same identity; reconcile conflicts by querying that receipt again.
6. Enforce bounded retries and backoff, plus metrics and a manual reconciliation path if the budget is exhausted.

## G. Verified archival before TTL

**Bad design:** enable TTL on append-only events and simply hope the consumer exports them in time.

**Safer design:** durable source → consistent snapshot/export or CDC projection → verified manifest, counts and sums → immutable archive watermark → controlled deletion or TTL eligibility. If a data range must become immutable after closure, enforce that invariant explicitly.

Persist the retention policy, last successfully archived watermark, external backup status and results of restore drills. Unconsumed CDC events can be lost after their own retention window independently of the original table's TTL.
