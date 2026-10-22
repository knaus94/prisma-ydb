# Official YDB Documentation Sources

Document links were collected for the skill on **2026-10-22**. Always prioritize documentation for the actual deployed YDB version: releases can change available YQL, indexing, ROW/COLUMN behavior and operator support.

## Storage, schemas, and keys

1. Table concepts, row and column stores, automatic partitioning: https://ydb.tech/docs/en/concepts/datamodel/table
2. Primary keys for row-oriented tables: https://ydb.tech/docs/en/dev/primary-key/row-oriented
3. Primary keys for column-oriented tables: https://ydb.tech/docs/en/dev/primary-key/column-oriented
4. `CREATE TABLE`, hash partitioning and table options: https://ydb.tech/docs/en/yql/reference/syntax/create_table/
5. Primitive types, Decimal and JSON: https://ydb.tech/docs/en/yql/reference/types/primitive
6. Database and API limits: https://ydb.tech/docs/en/concepts/limits-ydb

## Queries, indexes, and transactions

7. Secondary indexes (SYNC, ASYNC, UNIQUE, covering and local): https://ydb.tech/docs/en/concepts/query_execution/secondary_indexes
8. Secondary-index design guidance: https://ydb.tech/docs/en/dev/secondary-indexes
9. Transactions, isolation modes, distributed writes and ROW/COLUMN restrictions: https://ydb.tech/docs/en/concepts/transactions
10. SDK status codes, retry and `UNDETERMINED`: https://ydb.tech/docs/en/reference/ydb-sdk/ydb-status-codes
11. Explaining query plans: https://ydb.tech/docs/en/reference/ydb-cli/commands/explain-plan
12. YDB CLI SQL commands (`EXPLAIN`, profiling and stats): https://ydb.tech/docs/en/reference/ydb-cli/sql
13. `UPSERT` behavior: https://ydb.tech/docs/en/yql/reference/syntax/upsert_into

## Streaming, TTL, export and backup

14. Change Data Capture: https://ydb.tech/docs/en/concepts/cdc
15. TTL and eviction: https://ydb.tech/docs/en/concepts/ttl
16. S3 export and async operation status: https://ydb.tech/docs/en/reference/ydb-cli/export-import/export-s3
17. Exporting backup collections to external storage: https://ydb.tech/docs/en/recipes/backup-collections/exporting-to-external-storage
18. Export/import documentation: https://ydb.tech/docs/en/reference/ydb-cli/export-import/
19. General development guidance: https://ydb.tech/docs/en/dev/

## Common misconceptions to avoid

- **ROW sharding:** physical key **ranges**; **COLUMN partitioning:** hash of selected key fields, with PK-based ordering inside partitions.
- A SYNC secondary index is transactionally maintained distributed index data; ASYNC is eventual and unsuitable for strict invariants.
- Serializable does not imply an arbitrary global real-time order for transactions touching unrelated keys.
- `UNDETERMINED` does not mean “the write definitely failed.”
- `UPSERT` does not provide immutable once-only command registration by itself.
- YDB's changefeed guarantees do not automatically guarantee exactly-once processing in an outside consumer or sink.
- The current model does not support a single read-write ACID transaction spanning ROW and COLUMN writes.
- TTL guarantees neither immediate deletion nor preservation/export of valuable data.

## Version verification procedure

1. Determine the exact YDB version and deployment edition (self-hosted, operator, managed).
2. Use the documentation version selector or an appropriate `?version=vXX.Y` query parameter where supported.
3. Confirm any version-sensitive feature in release notes and DDL documentation, and test a minimal query in a disposable database.
4. State explicitly in the review whether the behavior is **verified against the target version** or **a hypothesis requiring verification**.
