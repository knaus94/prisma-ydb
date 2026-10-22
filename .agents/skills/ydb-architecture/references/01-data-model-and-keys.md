# 01. Data Modeling, Primary Keys, and Sharding

## Start with actual access patterns

For each table, determine: (a) how a row is created; (b) how it is usually read; (c) who modifies it and the degree of contention; (d) which bounded ranges are queried; (e) whether and when the data can be deleted or archived; and (f) how expensive a future primary-key change would be.

Produce a workload matrix such as:

| Operation | Lookup key | Ordering | TPS/QPS | Freshness | Acceptable fan-out |
|---|---|---|---|---|---|
| Get entity | `entityId` | None | TBD | Strict | One or few shards |
| List entity events | `entityId`, time window | Time DESC | TBD | Strict/eventual | One or few shards |
| Find by external ID | `externalId` | None | TBD | Strict | Index or projection |
| Scan metrics | Time, dimensions | `GROUP BY` | TBD | Eventual | Analytics pipeline |

Do not copy an existing normalized schema into YDB without this workload analysis.

## ROW vs. COLUMN

- **ROW:** frequent point lookups, short transactional updates, authoritative state and ordinary CRUD. The physical table is distributed by **ranges of its composite primary key**. Prefix-bounded range scans and keyset pagination can be efficient. A query missing leading PK fields may cause a broad scan or shard fan-out.
- **COLUMN:** analytical facts, compression, scanning a subset of columns, large aggregates and batch ingestion. The primary key determines order **within** a partition. `PARTITION BY HASH (columns)` determines distribution using selected **PK columns**, which need not be the PK prefix. A COLUMN partition is not the same physical structure as a ROW key-range shard.
- **Separate write state and analytics:** the same logical entity may have an authoritative ROW representation and an asynchronously updated COLUMN projection. Do not portray the writes as one atomic transaction.

## Algorithm for selecting a ROW primary key

1. Identify the most important point and range queries plus mandatory unique identifiers.
2. Start with a leading prefix known for most hot queries (`tenantId`, `entityId`, or `ownerId`) and providing the required bounded ordering.
3. Analyze key distribution and incoming write rate. If the first key component increases monotonically (such as `createdAt` or an ordered identifier), writes may concentrate at one range edge; assess alternative orders or spreading strategies.
4. **Do not add hashing by default.** Inserting `hash(ownerId)` before `ownerId` preserves a single-owner lookup when the hash is known, but global time-range queries now need fan-out or another projection.
5. `hash(x) % N` is an **application data contract**. Every writer and reader must compute it identically. Changing N is a data and code migration, not a trivial runtime tuning change.
6. If one tenant/user/entity dominates writes, hashing **only that ID** does not split the hot entity. For independent events, consider spreading by `eventId` or per-tenant sub-buckets; one mutable shared state row requires another concurrency algorithm, such as partitioned counters with careful coordination.
7. Evaluate multidimensional access. `(ownerId, occurredAt, eventId)` serves a given owner's history but not efficient standalone lookup by `eventId`. Account for out-of-order timestamps, backfills and late arrivals.

These are **candidate designs, not benchmark-proven defaults**:

```sql
-- History for a single owner: bounded by ownerId and time.
CREATE TABLE OwnerEvent (
    ownerId Uint64 NOT NULL,
    occurredAt Timestamp NOT NULL,
    eventId Utf8 NOT NULL,
    payload JsonDocument,
    PRIMARY KEY (ownerId, occurredAt, eventId)
);
```

If the owner dimension does not create a hotspot, extra hash buckets add complexity for no demonstrated benefit. If it does, distinguish hot range, hot row, excessive index writes and compute saturation before choosing a remedy. `AUTO_PARTITIONING_BY_LOAD` may split key ranges but cannot split one logical row's conflicting updates.

```sql
-- Possible candidate for spreading writes from many distinct owners.
-- The application computes partitionKey deterministically from ownerId.
CREATE TABLE DistributedOwnerEvent (
    partitionKey Uint32 NOT NULL,
    ownerId Uint64 NOT NULL,
    occurredAt Timestamp NOT NULL,
    eventId Utf8 NOT NULL,
    payload JsonDocument,
    PRIMARY KEY (partitionKey, ownerId, occurredAt, eventId)
);
```

A `partitionKey` value is **not guaranteed** to have exactly one physical partition. YDB determines the actual DataShard boundaries.

## ROW auto-partitioning

- Verify support and behavior of `AUTO_PARTITIONING_BY_SIZE`, `AUTO_PARTITIONING_BY_LOAD`, `AUTO_PARTITIONING_MIN_PARTITIONS_COUNT`, `AUTO_PARTITIONING_MAX_PARTITIONS_COUNT`, and `AUTO_PARTITIONING_PARTITION_SIZE_MB` in the deployed version.
- According to YDB documentation, size-based splitting is typically enabled by default for ROW tables, while load-based splitting is typically disabled. Managed environments can have different settings.
- For peak workloads, pre-splitting and minimum partition counts should follow observations of node count, core count, actual partition distribution and per-shard pressure—not a generic recommendation to “use 128.”
- When considering `UNIFORM_PARTITIONS`, verify the supported type of the **first** PK column (typically an unsigned integer) and the interaction with minimum partition counts; partitions may otherwise merge again.
- Splitting and merging are background operations and may transiently cause transaction retries. Never assume increasing partition count immediately increases throughput.

## Schema and data types

- Every table needs a primary key. Do not assume PostgreSQL `FOREIGN KEY`, `CHECK`, or database triggers. Design state-transition validation, relationships, and uniqueness not covered by the PK explicitly.
- Common mappings include `BIGINT → Int64` and `UUID → Uuid` for supported ROW schemas. `jsonb → JsonDocument` is **not** a byte-for-byte or semantic drop-in replacement. JSON numbers may lose precision: monetary values and exact counters belong in typed numeric columns.
- `Decimal(p,s)` supports precision **up to 35 digits**. Prove accumulation bounds, overflow behavior, and reconciliation requirements before replacing a PostgreSQL `NUMERIC` with a larger precision.
- For financial invariants, use fixed integer minor units (`Int64`) or a supported Decimal with proven precision and bounds; never `Double`.
- YQL expression types such as `Enum`, `List`, and `Struct` do **not** imply arbitrary support as table-column types. Model stored statuses with `Utf8`/`Int32` plus validation and a state machine; choose link tables or `JsonDocument` for arrays based on access patterns.
- YDB ROW columns can be nullable by default; PK columns must satisfy their required non-null semantics. Explicitly validate required non-key attributes at write boundaries and in tests. Verify NULL ordering and filter behavior.
- For uniqueness outside the PK, evaluate a supported `UNIQUE` global secondary index and its write cost; alternatively use an explicit mapping table keyed by the business identity and created atomically. A separate `SELECT exists` and later `INSERT` is **not** sufficient.
- Avoid oversized string or JSON key components. Keep hot rows narrow and verify database limits and type restrictions against the target version.

## Denormalization policy

Normalize authoritative state enough to preserve invariants. Denormalize read paths only for a clear need. Every duplicated projection must specify: source of truth, update mechanism (same SYNC transaction or ASYNC CDC), acceptable staleness, deduplication, backfill, validation, and rebuild procedure.

## Review questions

- Which queries do not supply the first PK component?
- Do incoming writes concentrate at a monotonically increasing key-range edge?
- Is there a hot tenant, entity, or globally shared counter?
- How many physical shards participate in the p99 operation—measured or merely assumed?
- What would changing the bucket-count algorithm cost a year from now?
- How are uniqueness and required data constraints enforced without PostgreSQL mechanisms?
