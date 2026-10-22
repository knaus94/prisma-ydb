# Schema and migrations

Edit `prisma/contract.prisma`. It is the authored schema. A generated contract
records its normalized models, tables, codecs and hashes; migration snapshots
record schema versions. **You do not maintain a second schema in TypeScript or
edit generated snapshots by hand.**

## Configure the project

The package's [installation guide](../README.md#configure) shows
`prisma.config.ts`. Its key paths are:

```ts
orm: defineYdbConfig({
  contract: './prisma/contract.prisma',
  relationMode: 'application',
  output: './src/generated',
  migrations: { dir: './prisma/migrations' },
  db: { connection: ydbBindingFromEnv() },
});
```

The consumer installs the pinned Prisma CLI. Run commands from the directory
containing its `prisma.config.ts`.

## Normal workflow

```bash
# After editing prisma/contract.prisma:
yarn prisma migration plan --name add-task-description
yarn prisma migration check
# Review the generated migration and snapshots before applying:
yarn prisma db migrate
yarn prisma db verify
yarn prisma contract emit
```

| Command                                          | Purpose                                               | Connects to YDB                                           |
| ------------------------------------------------ | ----------------------------------------------------- | --------------------------------------------------------- |
| `prisma contract emit`                           | Generate runtime contract and TypeScript declarations | No                                                        |
| `prisma migration plan --name change`            | Plan from schema and migration history                | No                                                        |
| `prisma migration new --name change`             | Scaffold a manually authored migration                | No                                                        |
| `prisma migration check`                         | Validate migration packages and graph                 | No                                                        |
| `prisma db migrate`                              | Apply pending migrations                              | Yes                                                       |
| `prisma db verify`                               | Compare the live schema with the desired contract     | Yes                                                       |
| `prisma migration status`                        | Inspect migration status                              | Yes by default; offline with an explicit non-`@db` origin |
| `prisma contract infer --output inferred.prisma` | Inspect the live schema in a separate file            | Yes                                                       |

The source workspace wraps these as `yarn db:migration:create`,
`yarn db:migration:new`, `yarn db:migration:check`, `yarn db:migrate`,
`yarn db:verify`, `yarn db:status`, `yarn db:infer` and `yarn example:generate`.
The wrappers target `examples/basic`.

For a new database, start with an empty migration history and plan the initial
schema. For an existing populated database, inspect its schema and the pinned
CLI's baseline options before adopting it. Do not apply an empty-history create
plan blindly to existing tables.

## Review and commit the artifacts

A migration package contains executable authoring code, metadata, normalized
operations and references to contract snapshots. Review `migration.ts`,
`migration.json`, `ops.json` and the referenced snapshots together. Check table
names, destructive changes, index definitions and any data transformation.

Commit the authored schema, migration packages and snapshots. Regenerate the
runtime contract and declarations during the build. Deploy checked-in migrations;
do not generate a new plan from a production database during deployment.

The optional `--advance-ref db` updates a repository reference. The provided
`db:migrate` deployment wrapper leaves that reference alone. Never edit an
already applied migration or its checksums; add a subsequent migration.

## Supported schema changes

The planner handles table creation/removal, column add/drop, supported default
and nullability changes, and synchronous indexes. Each DDL operation records
expected before/after table shapes for verification and recovery.

Automatic primary-key/type reconstruction is refused. Unique indexes can be
created with a new table; adding one to an existing table is rejected for the
pinned YDB version. Numeric TTL/tiering, column tables, covering/asynchronous indexes and
indexes still being built are not silently converted. Partitioning and replica
settings remain operational configuration outside this schema model.

Use a dedicated database for the managed contract: final verification also
checks for unrelated tables. Relations keep their ORM metadata while omitting
physical FKs. Action-bearing relations retain client-side behavior with no FK DDL. Read
[relations and referential integrity](relations.md) before defining deletion
rules or migrating existing references.

## Manual and data migrations

### TTL and storage types

```prisma
@@ttl(field: at, expireAfter: "P30D")
```

TTL accepts one temporal field per table (`DateTime`, `Date`, `Timestamp`) and a
nonempty ISO duration made of whole days/hours/minutes/seconds. Fractions,
months and years are rejected. Creation uses `WITH (TTL = Interval(...) ON ...)`;
policy changes use `ALTER TABLE ... SET (TTL = ...)`, and removal uses
`ALTER TABLE ... RESET (TTL)`. Setting/changing a policy is classified destructive
because background deletion can remove data. Review the generated operation.
Introspection preserves date-column TTL and rejects numeric TTL and tiering.
Expiry is asynchronous: queries must still filter out logically expired rows.

Value objects and scalar/enum lists are physical Json columns. Introspection
cannot recover list identity, object definitions or element codecs from Json;
native Timestamp is inferred as DateTime. Decimal precision/scale changes require
a reviewed data migration, since YDB cannot change a row-table column type in place.

`prisma migration new --name change` scaffolds a manual migration. Data-only
migrations without a schema change also need `--from <current-storage-hash>`.
Use the current snapshot's actual hash. The `prisma-ydb/control` entry exports
`ydbDataOperation`, `ydbSchemaOperation`, `YdbMigration` and `MigrationCLI`.

A reviewed data operation executes its DML, verification query and journal entry
in one Serializable transaction. Verification must return one row with boolean
`ok = true`. Custom DDL requires explicit before/after table shapes. Large data
backfills need a bounded, restartable application plan; a single migration
operation does not remove transaction or result limits.

## Recover an interrupted migration

YDB DDL is not transactional. A failure can leave some changes applied while the
contract marker remains at the previous version. The runner uses:

| Table                    | Purpose                                         |
| ------------------------ | ----------------------------------------------- |
| `_prisma_marker`         | Contract storage/profile hashes                 |
| `_prisma_ledger`         | Completed migration edges                       |
| `_prisma_ydb_migrations` | Operation journal and statement hashes          |
| `_prisma_ydb_lock`       | Exclusive owner, acquisition time, host and PID |

Retry the **unchanged** migration after resolving the failure. The runner uses
the journal and live table shapes to recognize completed steps and resume.
Unexpected drift or a checksum mismatch stops execution. Per-operation checks
inspect the target table; destination verification checks the complete schema.

A terminated deployer can leave a persistent lock. Establish that its process is
no longer running, inspect the journal and live schema, then release only the
recorded owner. Never release a live deployer's lock merely because it is old.
The library does not expire locks during potentially long DDL operations.

```ts
import { YdbDriver } from 'prisma-ydb/driver';
import { YdbControlDriver, releaseYdbMigrationLock } from 'prisma-ydb/control';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

const native = new YdbDriver();
try {
  await native.connect(ydbBindingFromEnv());
  // Use the exact owner from the interrupted deployment after investigation.
  await releaseYdbMigrationLock(new YdbControlDriver(native), recordedOwner);
} finally {
  await native.close();
}
```

A different owner is rejected. After recovery, rerun the migration and
`prisma db verify`. Do not repair control tables by guessing hashes or deleting
journal rows.

## Introspection and runtime verification

String enums are stored in `Utf8` columns. Adding or removing enum members changes
contract metadata and its storage hash, even though the physical column is
unchanged. Generate and apply the usual migration to record the new snapshot and
marker; a change limited to the member list has no DDL operations. Renaming a
member with an unchanged explicit stored string needs no data rewrite. Changing
the stored string requires an explicit data migration for existing rows.

`prisma contract infer --output inferred.prisma` writes a separate schema for
inspection. It cannot recover unconstrained relations or runtime ID generators.
It also cannot recover enum definitions: their columns are inferred as `String`.
Keep the original `.prisma` schema as the source of truth.

The runtime reads the marker on first use, including when the first operation is
an interactive transaction. In the pinned Prisma runtime, missing/mismatched
markers produce warnings; this is not a replacement for a deployment-time
`prisma db verify` gate. Raw DDL does not update the contract marker.

Official references: [YDB DDL](https://ydb.tech/docs/en/yql/reference/syntax/create_table/),
[pinned Prisma ORM source](https://github.com/prisma/orm/tree/v8.0.0-rc.18).
