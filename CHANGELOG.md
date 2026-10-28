# Changelog

## Unreleased

- Fix `db.changefeed` precision loss: Int64/Uint64 values, keys and virtual timestamps arrive as bare JSON numbers and are now parsed from their source text into exact `bigint`s; `raw` keeps unsafe integers as decimal strings.
- Fix `db.changefeed` decoding of `Date` columns, which YDB writes as midnight timestamps.
- Add `onPartitionStart` (with an optional start position), `onPartitionStop` and `onCommitted` hooks to `db.changefeed`. Omitted start-position fields keep the server's committed offset, hook exceptions end the iteration, and commits of a revoked partition reject with an `Error`. Events expose `partitionSessionId`.

## 0.1.0-rc.4

- Interactive transactions begin on the server with their first statement instead of a BeginTransaction RPC; empty transactions and rollbacks that never reached the server are local. `queryYql({ commit: true })` inside a transaction commits together with that statement.
- Decode result sets with per-column decoders built once per result set, and bound buffered results with a cheap per-row estimate.
- Strip compiler metadata comments from statement text before sending it; the parsed-header cache holds 2048 statements.
- Make the pause between whole-callback transaction retries end when the client closes.
- Resolve Prisma's prepared-statement bridge through its named internal export and verify the pinned runtime shape when a client is created, instead of scanning prototype symbols and degrading silently.
- Document that ORM calls compile on every invocation and that `db.prepare` is the hot-path alternative.
- Add `db.transaction(cb, { mode: 'snapshotReadOnly' })` for consistent multi-statement reads that never conflict with writers.
- Add `maxTransactionSessions`, a cap on sessions held across statements, and the `held` pool statistic.
- Read relation includes through `VIEW index WHERE fk IN $keys` when the child's foreign key is indexed or key-prefixed, turning child scans into lookups. Includes without such an index, grouped/distinct-on outer queries and `limit`/`offset` pages without `orderBy` keep the previous join.
- Add `db.bulkUpsert(model, rows)` on TableService BulkUpsert, `db.streaming` lanes without buffered result bounds, and `db.changefeed(model, { consumer })` decoding managed Json changefeeds. New dependency: `@ydbjs/topic` 6.1.4.
- Add `@@columnStore` for column-oriented tables: creation, introspection, verification and ORM mutations with emulated RETURNING. Row-only features (`@@index`, `@@unique`, `@@ttl`, `@@changefeed`, `@@partitioning`, `Uuid`, relation actions) are rejected at contract emission; changing a table's store kind is refused. Bulk uploads to column tables always carry full rows.
- Column-table mutations never read the table after writing it: on YDB 26.2 a row read back after its own update in one transaction ignores later deletes. Avoid that pattern in raw YQL as well.
- `tableExists` and `listYdbTables` accept column tables; standalone column stores are still rejected. Column-table duplicate keys map to Prisma's unique violation (`23505`).
- Add an offline compiler test lane (`yarn test:unit`) and live integration coverage for the features above.

## 0.1.0-rc.3

- Add a native `Uuid` scalar across ORM codecs, parameters, migrations and introspection, with validating `UuidValue` parameters while preserving the SDK `Uuid` export. Document server UUID ordering and keyset pagination.
- Bridge prepared queries to public YDB clients and active transaction contexts, retaining closed-client and settled-transaction checks.
- Add first-class `@@partitioning` and `@@changefeed` schema attributes with migration planning, introspection, verification, drift diagnostics and persisted checkpoint recovery.
- Preserve explicit false settings in hashed contract metadata with canonical `ENABLED`/`DISABLED` flags; keep booleans in schema authoring and schema IR.
- Add the integration suite and a pinned local-YDB CI job covering UUIDs, prepared queries, managed partitioning/changefeeds, drift and interrupted migration recovery.

- Tooling: leave workspace dependency updates to Yarn when bumping release versions, avoiding npm rejection of `workspace:*` dependencies.

## 0.1.0-rc.2

- Add string enums: generated literal types, flat `db.enums.<Name>` accessors (namespaced access retained) and contract printing of enum definitions and defaults.
- Add native Prisma 8 automatic timestamps: `temporal.createdAt()`, `temporal.updatedAt()` and `temporal.<DateTime|Timestamp|Date>(onCreate: now, onUpdate: now)`.
- Add `Decimal(p, s)`, calendar `Date` (`YYYY-MM-DD`) and exact microsecond `Timestamp` types across codecs, migrations, introspection and relation includes.
- Store scalar and enum lists as Json arrays (full replacement) with `fns.has/hasSome/hasEvery/isEmpty` filters; list filter values are bound parameters.
- Support typed nested value objects and JSON-path filters (`jsonString`, `jsonNumber`, `jsonBoolean`, `jsonExists`, `jsonIsNull`).
- Add client-side `onDelete` Cascade, SetNull and Restrict executed in one YQL program, with parent-existence checks on child writes (`YDB.REFERENTIAL_ACTION`).
- Add schema TTL (`@@ttl(field, expireAfter)`) with CREATE/SET/RESET planning and introspection of date-column TTL.
- Breaking: NoAction-only relation actions are rejected (use Restrict); `@default(now())` diagnostics point to the temporal presets.
- Raw YQL bypasses automatic timestamps and referential actions; TTL deletion is asynchronous, so filter expired rows.

## 0.1.0-rc.1

- Exclude sources and documentation guides from the npm package while retaining compiled code, types and declaration maps.
- Link package documentation to GitHub from the published README.
- Validate package contents with npm packing.

## 0.1.0-rc.0

- Extract native YDB driver, Prisma SQL-family runtime and migration support.
- Preserve upstream session/connection refactor and shared transaction backoff.
- Readiness becomes false from the start of client shutdown.
- Add public entry points, a standalone consumer, docs and release commands.
