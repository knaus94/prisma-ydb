# 06. Architecture Review Checklist and Acceptance Criteria

## Review process

For every finding, report severity (P0/P1/P2), specific impact, and evidence from DDL, code, execution plans, documentation or metrics. Do not call a personal preference a blocker without evidence. When the necessary workload details are unavailable, state testable hypotheses rather than guessing.

### A. Workload and keys

- [ ] A workload table exists with read/write QPS/TPS, hot/cold mix, p95/p99 targets and retention.
- [ ] Every ROW table has documented dominant queries and a justified leftmost PK prefix.
- [ ] Monotonic timestamp/sequence key-range hotspots and dominant tenant/entity keys have been assessed.
- [ ] Any bucket/hash choice documents the algorithm, N, collision behavior, fan-out, future N changes, and consistent derivation on read/write paths.
- [ ] Physical shard count and auto-split settings are driven by workload evidence, not copied from a template.
- [ ] COLUMN designs distinguish PRIMARY KEY from `PARTITION BY HASH` and justify ingestion volume and partition count.
- [ ] No unsupported promises of physical colocation of different tables.

### B. Correctness

- [ ] Invariants and enforcement mechanisms are explicit, especially without FKs, triggers and unsupported constraints.
- [ ] Critical read-modify-write transactions use an appropriate isolation mode.
- [ ] Write skew, hot-key contention, concurrent create/delete, and state-transition races are addressed.
- [ ] Every once-only command has a stable ID, request fingerprint, and durable outcome/evidence.
- [ ] Retries restart whole transactions; `UNDETERMINED` is reconciled using the authoritative receipt.
- [ ] Timeouts, redelivery and worker restarts cannot silently create duplicate effects.
- [ ] External RPCs happen outside DB transactions; a durable outbox/topic/saga design exists where needed.
- [ ] Money and exact quantities are not floating-point; type limits and overflow have been proven.
- [ ] TTL cannot erase in-progress operations or required deduplication evidence.

### C. Indexes and queries

- [ ] Each index is justified by a specific query and request frequency.
- [ ] Each SYNC index's potential additional distributed-write participants have been assessed.
- [ ] ASYNC freshness limits, forbidden stale-state decisions and rebuild protocols are documented.
- [ ] Pagination uses stable seek conditions, LIMIT and a unique tie-breaker.
- [ ] Hot OLTP paths do not have avoidable full scans, wide SELECTs or unbounded ORDER BY.
- [ ] p95/p99, rows read, shard fan-out and CPU have been compared before vs. after.

### D. Streams, TTL and backups

- [ ] CDC consumers are idempotent; retention covers expected outages or a backfill plan exists.
- [ ] There is an explicit recovery procedure for expired/lost stream offsets.
- [ ] The design does not claim atomic read-write transactions spanning ROW and COLUMN tables.
- [ ] TTL is not used as the sole guarantee of archival preservation or audit retention.
- [ ] Archival uses manifests, record counts/checksums, export completion checks and restore drills.
- [ ] Backups are isolated from the source cluster and have defined RPO/RTO.
- [ ] Asynchronous export and backup operations are polled through terminal status.

### E. Operations

- [ ] SDK endpoints, Discovery, advertised addresses, DNS/TLS and reachability from application Pods have been tested.
- [ ] Storage/compute roles, failure-domain placement, disk topology and replication are documented.
- [ ] Timeouts, retry budgets, backpressure and concurrency limits are defined.
- [ ] Alerts cover hot shards, transaction aborts, overload, topic lag, TTL, disk and backup failures.
- [ ] Representative load tests, fault injection, staging rollout and rollback are documented.

## Review report template

```markdown
# YDB Design Review

## Context
- YDB version / SDK:
- Workload / SLA / retention:
- Assumptions:

## Architecture choices
| Object | ROW/COLUMN | PK | Partitioning | Primary queries | Fan-out |
|---|---|---|---|---|---|

## Indexes and projections
| Object | Index/projection | Consistency | Write cost | Rationale |
|---|---|---|---|---|

## Transactions and idempotency
- Invariants:
- Atomic boundary:
- Conflict keys / retry policy:
- UNDETERMINED recovery:

## Findings
| Severity | Location | Risk | Evidence | Remediation | Test |
|---|---|---|---|---|---|

## S3 / TTL / CDC / observability
- Source of truth, watermark, retention, RPO/RTO:

## Rollout
- Migration, backfill, rollback, SLO acceptance:
```

## Minimum acceptance tests

- [ ] p99 of critical transactions at projected peak TPS meets the target SLO.
- [ ] P0 business invariants survive concurrency, retries, timeouts and restarts.
- [ ] No unmanaged hot shard imposes unacceptable throughput limits.
- [ ] The write and cleanup costs of secondary indexes have been measured.
- [ ] CDC lag, duplication and recovery meet the stated contract.
- [ ] A restore drill demonstrates integrity and usable data availability.
- [ ] All SDK APIs, SQL and features have been checked against the installed YDB release.
