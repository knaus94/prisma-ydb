# Changelog

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
