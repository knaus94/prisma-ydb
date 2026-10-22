---
name: ydb-architecture
description: >-
  Design, implement, optimize, and review YDB/YQL data architectures, including
  row and column stores, primary keys, sharding, indexes, distributed ACID
  transactions, idempotency, CDC/Topics, TTL, S3, availability, and performance.
  Use when designing or modifying YDB schemas, writing YQL, evaluating query
  patterns or transaction correctness, reviewing YDB architectures, diagnosing
  performance, or planning a migration from another database to YDB.
---

# YDB Architecture & Engineering Rules

> **Purpose:** General-purpose engineering guidance for agents working on any YDB-based system. Do not mistake YDB design for a mechanical translation of PostgreSQL or another database's schema and SQL.
>
> **Language:** Write skill instructions, file content, and internal engineering artifacts in English. When responding to an end user, use the user's requested language unless they explicitly request English. Keep code, API names, and SQL keywords unchanged.

## 0. Required agent workflow

1. **Establish the context.** Identify the YDB version and deployment model (self-hosted vs. managed), SDK and services, SLOs, peak TPS, data volume and growth, representative queries, batch sizes, RPO/RTO, consistency and freshness expectations, and infrastructure constraints. Explicitly state unknowns and assumptions; never fabricate workload numbers.
2. **Describe operations before DDL.** Build a workload matrix: operation → read/write QPS or TPS → `WHERE`/`JOIN`/`ORDER BY` → cardinality → response size → required consistency → bounded time range → target p95/p99.
3. **Specify invariants.** Define uniqueness, allowed state transitions, existence of related entities, once-only execution, atomic changes, event ordering, retention, and audit requirements. Do not assume PostgreSQL-level constraints exist in YDB.
4. **Design tables around access paths.** Choose ROW or COLUMN storage. For ROW tables, justify the leading PK fields, possible hotspots, and query fan-out. For COLUMN tables, distinguish PK-based ordering from `PARTITION BY HASH` distribution.
5. **Design transactions and failure handling.** Specify atomic boundaries, expected shard participants, idempotency, retry semantics, uncertain commits, external side effects, and recovery protocols.
6. **Add indexes only for established needs.** For each index, document the query it serves, its type (SYNC/ASYNC/local where supported), expected benefit, write amplification, and freshness requirements.
7. **Plan data lifecycle.** Cover TTL, CDC, Topics, backfill, archives, S3, backups, restore, migrations, deletions, and lag monitoring.
8. **Validate.** Verify YQL syntax and feature availability against the target version; request or run `EXPLAIN`, realistic p50/p95/p99 tests, CPU and I/O analysis, shard distribution, conflicts, throttling, and storage-cost measurements. Label hypotheses as hypotheses.
9. **Deliver actionable output.** Provide a schema, representative queries or labeled pseudocode, trade-offs, failure tests, and a rollout/rollback plan. Never recommend “add more nodes” without analyzing the bottleneck.

## 1. Non-negotiable engineering rules

- **YDB is not PostgreSQL.** Do not invent support for PostgreSQL `FOREIGN KEY`, server-side `BEFORE/AFTER` triggers, PL/pgSQL, `CHECK`, or PostgreSQL extensions. Verify any version-sensitive constraint or DDL feature before using it.
- **ROW storage:** DataShards divide a table into **ranges of the primary key**. Choose the leading PK fields for both frequently bounded reads and balanced writes. An application-level hash bucket is optional, not a universal requirement.
- **COLUMN storage:** Partition distribution uses **`PARTITION BY HASH`**; the PK controls order within a column partition. Do not confuse these mechanisms. Verify partition-count and splitting behavior for the target release.
- **Bucket is not shard.** A bucket is a logical key value, not a physical DataShard. Identical key prefixes in different tables do not guarantee physical colocation or a single-shard transaction.
- **Avoid hot key ranges.** A leading timestamp, increasing sequence, current global round ID, dominant tenant, or shared counter can concentrate writes. Hashing an entity ID does not alleviate repeated updates to that exact entity.
- **Never weaken transaction correctness for performance.** Required business invariants must be preserved through appropriate Serializable ROW-table transactions or an explicitly proven coordination protocol. An eventual analytics projection is not an authoritative state store.
- **Do not assume an atomic read-write transaction spanning ROW and COLUMN tables.** Use CDC, Topics, Transfer, or an explicit asynchronous pipeline with documented consistency and lag.
- **Global SYNC secondary indexes have a real distributed write cost.** They are separately maintained index tables. ASYNC indexes have eventual consistency and must not be used as authoritative, strictly fresh reads.
- **Retries require idempotency analysis.** A commit reported as `UNDETERMINED` may already have succeeded. Retrying as a new command can duplicate side effects.
- **`UPSERT` is not `INSERT`.** It can overwrite an existing record; never use unconditional UPSERT to register an immutable, once-only command without a proven uniqueness protocol.
- **TTL is neither immediate deletion nor backup.** Deletion can lag; indexed ROW-table cleanup has write cost. Verify archiving and completeness before deleting valuable history.
- **CDC does not imply exactly-once delivery into an external sink.** Design idempotent consumers, deduplication, checkpointing, backfill, and lag alarms. A produced event alone does not prove an archive is complete.
- **Treat wide reads and long transactions as risks.** Avoid unbounded `SELECT *`, broad JOINs, OFFSET pagination, expensive scans, and network calls on hot transactional paths without measurements and explicit budgets.
- **Never present arbitrary tuning numbers as rules.** Bucket counts such as 16/64/128, shard sizes, node counts, and latency figures are hypotheses or initial test points unless supported by version-specific documentation and benchmarks.

## 2. Quick decision tree

- **Frequent point reads/writes and strict ACID:** use ROW storage; optimize PK prefixes, bounded scans, and short transactions. See [data model and keys](references/01-data-model-and-keys.md) and [transactions](references/03-transactions-and-correctness.md).
- **Large aggregations, time-range scans, analytics, batch ingestion:** evaluate COLUMN storage; choose hash partitioning, sorting, and partition count separately. See [streaming and analytics](references/04-streaming-analytics-lifecycle.md).
- **Frequent lookups outside the PK:** first evaluate a different PK or query shape; then consider supported SYNC/ASYNC/covering/local indexes or purpose-built projections. See [queries and access paths](references/02-access-paths-and-queries.md).
- **Transaction plus external service:** commit local state atomically; publish through a supported transactional topic or durable outbox; process externally through idempotent consumers or a saga. Never hold a YDB transaction open across network RPCs.
- **Archived history:** verified export and independent backups; TTL only after an explicit retention and preservation protocol.
- **Cluster operations:** use discovery, separate storage/compute roles, proper persistent storage, per-node metrics, and tested restore. See [operations and performance](references/05-operations-performance.md).

## 3. Expected deliverable for an architecture task

Present findings in this order, adjusted to the actual scope:

1. **Requirements and assumptions:** volume, RPS/TPS, p99, consistency, hot entities, retention.
2. **Workload matrix:** primary operations, query predicates, estimated or measured shard fan-out.
3. **Data model:** ROW/COLUMN, fields, PK ordering, optional bucket/hash rationale, newly expensive read paths.
4. **Index and projection plan:** SYNC/ASYNC behavior, write cost, freshness, deduplication and alternatives.
5. **Transaction protocol:** atomic boundaries, conflicts, retries, `UNDETERMINED`, idempotency and external effects.
6. **Lifecycle:** TTL, Topics/CDC, OLAP, S3, backups, restore and retained evidence.
7. **Risks and trade-offs:** hotspots, distributed write amplification, TTL/GC, failure recovery and total cost.
8. **Validation and rollout:** explain plans, load tests, fault injection, migration, acceptance criteria and rollback.

For a small YQL request, do **not** force the entire architecture report into the reply. Apply the relevant rules internally, deliver the requested code, and mention only important assumptions.

## 4. Automatic design-review blockers

If a proposal includes any of these, **explicitly flag the risk and suggest a safer alternative**:

- Monotonically increasing `createdAt` leading the PK of a high-write ROW table without an assessed distribution strategy.
- One globally updated counter/key in every high-frequency request.
- Many global SYNC indexes on a write-heavy table without write-amplification estimates.
- Using an ASYNC index or stale read to enforce an immediate balance, quota, ownership, reservation, or uniqueness invariant.
- An unconditional UPSERT into a once-only command/receipt table.
- Automatic retries of irreversible financial or external actions without stable operation identity.
- TTL applied to unfinished work, unarchived events, or permanently required deduplication/audit evidence.
- Attempting atomic ROW+COLUMN writes in one transaction.
- External HTTP/RPC calls while a YDB transaction is open.
- Claiming a common bucket implies cross-table shard colocation.
- Assuming PostgreSQL FKs, triggers, enums, PL/pgSQL, or constraints exist in YQL.
- A migration or deletion plan without reconciliation, backup/restore checks, observability, and rollback.

## 5. Reference routing

Read **only the relevant reference files** for the task:

| Task | Reference |
|---|---|
| ROW/COLUMN, keys, hotspots, types, data modeling | [01-data-model-and-keys.md](references/01-data-model-and-keys.md) |
| Indexes, queries, projections, pagination, EXPLAIN | [02-access-paths-and-queries.md](references/02-access-paths-and-queries.md) |
| ACID, retries, idempotency, external operations | [03-transactions-and-correctness.md](references/03-transactions-and-correctness.md) |
| COLUMN, CDC, Topics, TTL, S3 and backups | [04-streaming-analytics-lifecycle.md](references/04-streaming-analytics-lifecycle.md) |
| Kubernetes, SDK, monitoring, workload testing | [05-operations-performance.md](references/05-operations-performance.md) |
| Review checklist and acceptance criteria | [06-review-checklist.md](references/06-review-checklist.md) |
| Generic design examples | [design-patterns.md](examples/design-patterns.md) |
| Official documentation links | [sources.md](references/sources.md) |

## 6. Version and evidence policy

- Use the documentation for the user's **actual deployed YDB version**. Documentation for the newest version can differ from the installed release. Mark unfamiliar functionality “requires verification on the target version.”
- Mark SQL as **validated** only after checking supported syntax or compiling/running it on a compatible YDB instance. Label architecture examples as examples and SDK-style sketches as pseudocode where appropriate.
- Separate **documented semantic guarantees** from **architecture choices** that require workload testing.
- Never promise a fixed TPS, exact p99, physical colocation, zero data loss, or instantaneous failover without evidence.
- Prefer official documentation and the version-check process in `references/sources.md`.
