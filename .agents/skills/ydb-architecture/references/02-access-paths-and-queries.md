# 02. Access Paths, Indexes, Pagination, and Query Costs

## Plan from queries

First inventory the queries and their relationship to each table's PK. For each query, document:

- Estimated percentage of rows and shards touched, and bytes transferred over the network.
- Equality constraints on the **leftmost components of a composite PK**, followed by a range on the next component if applicable.
- Whether it requires global search, JOIN, SORT, DISTINCT, `GROUP BY`, or materialization.
- Whether a JOIN can be replaced by point lookups or a read projection; whether that projection must be immediately consistent.
- Exactly which columns are needed (prefer narrow selection to `SELECT *`), and the keyset cursor or LIMIT.
- Evidence from `EXPLAIN` or query profiles **against representative data**.

## Choosing secondary indexes

1. Show why the query cannot be efficiently served by the existing PK.
2. For strict uniqueness by a secondary business key, consider a supported `GLOBAL UNIQUE SYNC` index **if available in the target release**, or a key-mapping table written inside a Serializable transaction.
3. If the index is needed to make a strictly current decision, use a **synchronous, consistent** read path. An ASYNC index is not a source of truth.
4. When delayed results are acceptable, consider an ASYNC index or CDC-maintained projection. State a freshness limit and verify the eligible read mode (including `Stale Read Only` restrictions for ASYNC indexes in applicable versions).
5. For hot queries returning only a few columns, consider `COVER`/covering indexes; duplicated stored columns increase disk usage and write work.
6. Evaluate version-specific local Bloom, min-max, JSON, full-text and vector indexes for their actual table type and query pattern. Do not assume these index types are interchangeable or available for every store.
7. A global index is physically a separately maintained table, with independent sharding. A SYNC global index can add participants to a distributed commit. Benchmark **write amplification**, not just read speed.

Illustrative schema; verify syntax/features on the installed release:

```sql
CREATE TABLE TaskById (
    taskId Utf8 NOT NULL,
    ownerId Uint64 NOT NULL,
    status Utf8,
    updatedAt Timestamp,
    INDEX by_owner GLOBAL SYNC ON (ownerId),
    PRIMARY KEY (taskId)
);
```

This trades additional write cost for lookup by `ownerId`. It does **not** mean every attribute needs an index. An alternative can be `PRIMARY KEY(ownerId, taskId)` plus an explicit mapping keyed by `taskId`: choose based on the dominant access pattern.

## Explicit projections vs. indexes

An explicit `EntityByExternalKey(externalKey PRIMARY KEY, entityId)` may offer more control than a secondary index, but must have a correct maintenance protocol. For immediate consistency, maintain the mapping in the **same ACID transaction**, accepting possible cross-shard cost and concurrency conflicts. Otherwise, use CDC and an asynchronous consumer with version/event ID, deduplication, and rebuild capabilities.

Do not create a synchronous projection “for performance” if it becomes as costly a distributed-write participant as the index it replaces.

## Pagination and time ranges

- Prefer **keyset/seek pagination** with a known leading PK prefix, deterministic ordering with a unique tie-breaker, a predicate after the last returned key, and `LIMIT`.
- Avoid deep `OFFSET` pagination on ever-growing tables; skipped-row work increases with page depth.
- Account for descending time order, duplicate timestamps, UTC conventions, snapshot consistency, and the possibility of duplicates/gaps while new rows arrive.
- A column named `createdAt` does not make an unbounded global time scan efficient.
- With key `(ownerId, createdAt, eventId)`, `WHERE ownerId = ... AND createdAt >= ...` can bound the read; `WHERE createdAt >= ...` without ownerId generally cannot.

## JOIN and aggregation

- YDB supports JOIN; do not ban JOIN categorically. Evaluate input cardinality, network reshuffling, join keys, memory use, and the actual execution plan.
- For small reference datasets, compare JOIN, cache, or point lookup. Do not introduce duplicated attributes without an explicit consistency and refresh plan.
- Route expensive historical `GROUP BY` and reporting to a separate OLAP workload when they compete with latency-sensitive OLTP.
- For broad ROW queries, consider purpose-built lookups, a supported covering index, or read projections **only after measuring** current plans.

## Verify execution plans

YDB CLI exposes ways to explain and profile SQL, including `ydb sql --explain`, `--explain-analyze`, or `--stats` in versions that support those options. Confirm the precise syntax via `ydb sql --help` for the deployed CLI. Preserve:

- Plans before and after the change.
- Rows examined vs. rows returned.
- CPU time and processed bytes.
- Number of shards contacted and degree of fan-out.
- p50/p95/p99 under representative concurrency.
- Added write overhead and index-maintenance cost.

**Unacceptable conclusion:** “Add an index; it will help” without a concrete query and an estimate of the cost imposed on writes.
