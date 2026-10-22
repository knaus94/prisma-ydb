# 05. Runtime, Kubernetes, Availability, Monitoring, and Performance Testing

## Application connectivity through an SDK

- Use an official SDK compatible with the installed YDB release. Configure a **bootstrap endpoint** and **database path**; do not hardcode the list of all physical nodes instead of using supported discovery.
- In self-hosted Kubernetes, an internal ClusterIP Service can provide the initial gRPC endpoint to **dynamic/compute** nodes. YDB Discovery then advertises individual server addresses the SDK may connect to directly.
- **Critical:** discovered addresses must be reachable from the application. A ClusterIP Service does not automatically solve inaccessible Pod IPs, advertised DNS names, inter-cluster NAT or network-policy restrictions.
- For applications outside the Kubernetes cluster, consider a suitable gRPC load balancer/proxy and an explicitly designed advertised-endpoint topology. Test the actual SDK behavior rather than assuming any generic proxy setup works.
- Use one long-lived Driver/Client per process, managed session/connection pools, bounded in-flight requests and graceful shutdown. Never create a Driver per request.
- In production, enable TLS with verified certificates, appropriate service accounts or credentials, least privilege and rotation. Do not embed secrets in source control or disable TLS verification for convenience.
- For Node.js, Go, Java and other SDKs, verify package versions, transaction APIs, cancellation, retry and session semantics before providing supposedly executable code. Never invent method names based on another SDK.

## Kubernetes deployment

- Distinguish **storage/static nodes** and **dynamic/compute nodes**. Storage nodes need persistent disks; compute nodes serve SQL/gRPC and can scale separately.
- Verify the operator's storage requirements, block-mode PVC support (`volumeMode: Block`), StorageClass and CSI behavior. Shared NFS volumes are not automatically an equivalent substitute for YDB storage device requirements.
- Define the real availability model: independent failure domains, anti-affinity, topology spread, disruption budgets, and whether the infrastructure actually has enough zones for the chosen replication/erasure scheme.
- YDB replication is **not a backup**. Accidental deletion and logically corrupted application data can be faithfully replicated.
- Ten Pods on the same physical host, in one failure zone, or on one underlying shared storage failure domain do not automatically provide high availability.
- Kubernetes Services serving clients must select healthy **dynamic** nodes; do not send all SQL traffic indiscriminately to storage-only Pods.

## Monitoring

Scrape appropriate metrics **from every relevant YDB node/pod**, not merely from one load-balanced Service endpoint. YDB exposes Prometheus-compatible metrics; verify the exact port, endpoint, security mode and labels for the deployment and release. At minimum, Grafana should show:

| Signal | Purpose |
|---|---|
| Requests/sec, errors/sec, timeouts | User-facing quality and saturation |
| p50/p95/p99 latency and queue time | Tail-latency diagnosis |
| `ABORTED`, `UNDETERMINED`, `OVERLOADED` | Transaction conflicts and overload/backpressure |
| CPU/RAM/network per compute/storage node | Find the actual overloaded tier |
| DataShard/tablet count, split/merge, hot shards | Distribution and repartitioning behavior |
| Used/free storage, disk IOPS and latency | Capacity exhaustion and storage bottlenecks |
| Topic ingress/egress, consumer lag, expired offsets | Projection correctness and recoverability |
| TTL backlog, archive watermark, backup/restore status | History-loss risk and disaster-recovery readiness |
| Slow queries, scan CPU, shards contacted | Bad PK choices, indexes and execution plans |

Do **not** invent exact Prometheus metric names. Inspect the real `/metrics` endpoint or published dashboards for the installed release and verify query labels.

## What to benchmark

**Workload scenarios:**

1. Uniform point reads and inserts over many independent keys.
2. Strong skew, hot tenants, and a single intensely updated record.
3. Serializable read-modify-write within one table.
4. Multi-table/multi-shard Serializable transactions with 0, 1, and N SYNC indexes.
5. Idempotent replay, deliberate concurrency conflicts, and ambiguous commit recovery.
6. Batch COLUMN ingest while running analytical scans.
7. TTL cleanup during peak transactional writes.
8. Node crash, network partition, shard relocation, expired sessions, timeouts, and `UNDETERMINED` outcomes.
9. CDC consumer lag, consumer outages, duplicate events and expired-offset recovery.
10. Backup and restore drills under representative but safe staging loads.

**Mandatory measurements:** acknowledged TPS, latency percentiles, abort and retry rates, number of shards involved, CPU/I/O per node, SYNC index size, storage/write amplification, consumer lag, and violated correctness invariants (**must remain zero**).

Run controlled comparisons of the same workload with alternative PKs (natural, reordered, optionally hashed), 0/1/N SYNC indexes, asynchronous projections, and different compute/storage capacity. Record data volume, warm-up, concurrency, and cluster settings so results are comparable.

## Capacity and cost

- `10 Pods` is not a sizing rule. Account for role distribution, CPU, RAM, SSD latency/IOPS, failure tolerance, partition count and data replication.
- Horizontal scale helps many **independent** operations; it does not remove serialization on one logical record.
- Heavy transactional coupling can make coordination/network overhead exceed the benefit of adding more nodes.
- Estimate data bytes plus replication/erasure overhead, secondary indexes, retention, backups, archives and spare rebalance/headroom capacity.
- Include cross-zone RTT, network traffic and external S3/CDC expense. Hot-query latency SLOs and cold-storage recovery times are different targets.

## Release, migration and rollback

1. Version-control migrations and test them in staging with a representative workload.
2. Prefer backward-compatible schema expansion, bounded cursor-based backfill, cutover to **one authoritative writer**, and only then removal of old fields or stores.
3. Never change hash/bucket algorithms without a read-compatibility strategy, PK redistribution, deduplication and cutover planning.
4. For CDC consumers, coordinate initial scan, consistent stream handoff/barriers, and backfill after downtime longer than topic retention.
5. For migrations from PostgreSQL, perform an explicit compatibility analysis: FK, triggers, enums, arrays, high-precision numerics, functions, indexes, serialization/isolation semantics, ORM, and client APIs.
6. Critical migrations need pre/post row counts, totals and checksums, smoke tests, backup/restore checks, rollback, and monitoring. Do not delete the source before proving the destination is complete and authoritative.
