# 04. OLAP, CDC, Topics, TTL, S3, and Data Lifecycle

## Keep analytics architecturally distinct

- `STORE = ROW`: authoritative state, small interactive reads, high-concurrency transactional mutations.
- `STORE = COLUMN`: large analytical facts, reading selected columns efficiently, aggregation, batch ingestion and compression.
- Do not assume one read-write ACID transaction can atomically update both ROW and COLUMN tables in the current YDB model. Use CDC, Topics, Transfer, or an explicit asynchronous projection pipeline.
- If OLAP workloads interfere with latency-sensitive OLTP, allocate separate databases, compute resources or capacity pools as appropriate. Different table types in the same database do not by themselves guarantee performance isolation.

## Design COLUMN tables deliberately

1. Identify primary analytical predicates: time windows, tenants/dimensions, measures and `GROUP BY` keys.
2. Choose **`PARTITION BY HASH`** from PK columns to spread large writes. Hash distribution is **not** the same as ROW-style time-range partitioning.
3. Choose PK order for efficient within-partition sorting, common filters and compression, while considering late-arriving records and sort/merge overhead.
4. Size partition count for bytes/sec, worker count, batch sizes and key skew. For releases where COLUMN partitions cannot automatically split after creation, do not overprovision an arbitrary 1,024 partitions “just in case.” Verify current behavior.
5. Ingest suitable batches. Avoid high-frequency point updates and complex read-modify-write transactions on analytical fact tables.
6. In relevant current versions, COLUMN tables lack global secondary indexes and CDC but offer selected local skip indexes. Confirm column and key type restrictions against the deployed version.
7. For S3/Parquet analytics, account for object access cost, network latency, partition pruning, file layout and archival storage classes.

### Minimal illustrative example (verify against the target release)

```sql
CREATE TABLE TelemetryFact (
    tenantId Uint64 NOT NULL,
    eventAt Timestamp NOT NULL,
    eventId Utf8 NOT NULL,
    metric Utf8,
    value Double,
    PRIMARY KEY (tenantId, eventAt, eventId)
)
PARTITION BY HASH (tenantId)
WITH (
    STORE = COLUMN,
    AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = 64
);
```

This is a design illustration, not a benchmark recommendation. If one tenant accounts for most writes, hashing only `tenantId` creates skew; choose a partition key with sufficient cardinality. Never use `Double` for exact monetary values.

## CDC, Topics, and downstream processing

- CDC is supported for **ROW** tables. Per-primary-key change order is maintained within the corresponding topic partition according to the relevant CDC semantics.
- CDC events become available **after successful source transaction commit**. This does not make downstream projections immediately current.
- Track changefeed/topic retention. Documentation may list a 24-hour default and version-specific configurable limits; verify the actual maximum for your release and deployment. A stalled consumer can permanently miss messages after retention expires, requiring backfill or rebuild.
- When attaching CDC to an existing dataset, explicitly coordinate initial snapshot/backfill with stream consumption, a valid handoff watermark, deduplication and ordering.
- “Exactly once” guarantees for a YDB changefeed **do not automatically imply** exactly-once application to Kafka consumers, external SQL stores or S3. Design receiver-side `eventId`, version and offset deduplication.
- Where supported, YDB Topics can participate in a transaction with ROW tables; do not generalize this to COLUMN writes. Verify the operation and SDK transaction semantics for the installed version.
- Stateful consumers need lag limits, DLQ/retry policy, deduplication retention, poison-message handling, sequence/version enforcement and a repair runbook.

## TTL: deletion is not a retention guarantee

- TTL is based on a time/timestamp column. A null expiration value may prevent expiry and can be useful for nonterminal records; set `expiresAt` only on a safe terminal transition after confirming the deployed semantics.
- Cleanup runs asynchronously. If expired rows must become invisible immediately, enforce expiration in application queries too (for example, `WHERE expiresAt > now()`).
- Avoid TTL on unfinished commands, permanently required dedup keys, active sagas or audit evidence that has not been verifiably exported.
- For ROW tables with secondary indexes, TTL can perform distributed transactional deletions. Benchmark ingress **and** cleanup under peak load.
- COLUMN tables may support native tiering/eviction to external S3. **Do not assume** ROW tables have the same automatic tiered-export capability; they may require a separate export/checkpoint protocol.
- TTL is not equivalent to near-instant `DROP PARTITION` in PostgreSQL. Measure cleanup delay and CPU/I/O cost during mass expirations.

## Safe archiving protocol

For data needed for audits, historical reads, or recovery:

1. Identify a **closed, immutable** key/time range, or use a well-defined consistent snapshot/export contract.
2. Export to a versioned S3 prefix; do not overwrite active backup generations.
3. Wait for the **asynchronous server-side export operation** to reach successful terminal status. Starting the CLI command does not prove export completion.
4. Verify record counts, key ranges, aggregates/checksums, and completeness of related entities. Persist manifests, version identifiers and validation metadata.
5. Perform restore drills and verify actual S3 storage-class availability. Glacier-like archival classes can require rehydration before objects can be read.
6. **Only after verified preservation** allow TTL or controlled deletion, or mark that range eligible for later cleanup.
7. Maintain reconciliation/backfill jobs and alerts on gaps between producer, consumer, archive and deletion watermarks.

## Backups and disaster recovery

- `ydb export s3` performs an asynchronous server-side export; poll operation status until success/failure is conclusive.
- Use backup collections and incremental chains only after confirming version support, prerequisites and restore semantics. Full backups and dependent incrementals need chain integrity and ordering validation.
- Store backups separately from the production cluster and its everyday credentials. Use encryption, access isolation, lifecycle policies and least-privilege secrets.
- Record RPO/RTO, restore-test cadence, completeness checks, schema-version compatibility and necessary seed/reference data.
- **Backups, CDC and historical archives serve different purposes.** CDC is not a complete point-in-time restore mechanism; a selective history export does not replace the operational database backup.

## Reference design choices

- **Live leaderboard:** authoritative ROW counters or event-sourced state, plus an asynchronous read projection with explicit freshness.
- **Audit log:** immutable ROW event → CDC → COLUMN/S3; TTL only after verified archival.
- **Near-real-time analytics:** bounded batches or Transfer → COLUMN, independent capacity budget, monitored end-to-end lag.
- **Event-based quota:** Serializable check and deduction against an authoritative key; analytical projections never decide quota enforcement.
