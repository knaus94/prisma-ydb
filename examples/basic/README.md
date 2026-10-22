# Basic consumer

From the repository root:

```bash
cp examples/basic/.env.example examples/basic/.env
yarn db:up
yarn db:migrate
yarn db:verify
yarn example:run
```

Edit `prisma/contract.prisma`. Generated client files go to `src/generated`.
`selections.ts` defines shared queries/inferred types; `dto.ts` implements them.
`main.ts` combines ORM and YQL in one transaction, reuses a selection after commit
and deletes only rows created by the current run.

`Task.status` uses the generated `TaskStatus` enum, stored as YDB `Utf8` with a
`TODO` default. The example writes and filters using `db.enums.TaskStatus` and
`tx.enums.TaskStatus`, includes the typed status in the shared selection/DTO, and
shows the `.has()` membership check.

The schema also demonstrates exact `Decimal(12, 2)` budgets, `Date` due dates,
Json-backed tags, nested value objects and native `temporal.*` timestamps.
The program prints an update's unchanged `createdAt` and advanced `updatedAt`,
JSON boolean/string path filters, and `fns.has`/`hasSome` list filters.
`AuditEvent.at` is a microsecond Timestamp with a 30-day TTL. Queries still
filter `at` against the cutoff because physical TTL deletion is asynchronous.
Cleanup deletes the project only: client-side Cascade removes its tasks, then
the program confirms no task remains. Audit cleanup removes only this run's ID.
The transaction, raw YQL and reusable selection demonstrations are retained.

The feature upgrade uses two migrations for populated databases. The first adds
`Task.updatedAt` as NOT NULL with a temporary epoch literal default, then a
reviewed transactional data operation copies each existing `createdAt` into it
and verifies equality. The next removes that storage default; the final schema
uses `temporal.updatedAt()`. Prisma 8 rc.18 does not allow optional presets or
combining a preset with `@default`, so a direct required-column addition is
rejected. Snapshots are generated from the intermediate/final authored schemas;
they are never edited by hand. Pause writers during this bounded example upgrade
so the backfill and default removal cannot race legacy clients. Large tables
need a separate bounded, restartable backfill plan.

From the repository root, regenerate/check/apply before running:

```bash
yarn example:generate
yarn db:migration:check
yarn db:migrate
yarn db:verify
yarn db:status
yarn example:run
```

Yarn links the dependency via `workspace:*`. Outside this repository, install the
published package or tarball and keep the explicit Prisma platform dependencies
needed by generated type imports.
