# prisma-ydb

Standalone Yarn/Nx workspace for the native YDB integration with Prisma ORM 8.
The publishable package is [packages/prisma-ydb](packages/prisma-ydb); the
private consumer is [examples/basic](examples/basic).

Pinned compatibility: Prisma CLI **8.0.0-rc.24**, ORM platform packages
**8.0.0-rc.18**, YDB JS SDK **6.3.1**. This is an experimental RC integration,
not a certified production release. It uses the Prisma 8 SQL-family API with typed collections, fragments and contracts.

Native `Uuid` columns use canonical lowercase strings in JavaScript. Prepared
handles execute directly on the client or a live transaction; see the package
API guides for UUID parameters and prepared selections.

## Development

Use Node `^24.11.0 || >=26.0.0`. Yarn 4.18.1 is included in `.yarn/releases`.

```bash
yarn install --immutable
yarn check
yarn package:pack
yarn release:dry-run
```

Without a Yarn launcher, use `node .yarn/releases/yarn-4.18.1.cjs` in place of
`yarn`. Checks cover lint, TypeScript/build, package validation and migration
validation. The offline checks do not connect to a database. The opt-in live
integration suite uses Node 24's test runner with one file at a time:

```bash
YDB_CONNECTION_STRING=grpc://localhost:2137/local YDB_ANONYMOUS_CREDENTIALS=1 yarn test:integration
```

Use an empty, disposable database: migration cases refuse pre-existing deployment
metadata, and each fixture drops its own tables, feeds and migration metadata in
after hooks. After `yarn db:migrate` or `yarn example:run` the local volume holds
`_prisma_*` tables, so reset it first with `docker compose -f docker/compose.yaml down -v`
followed by `yarn db:up`. Missing `YDB_CONNECTION_STRING` is an error. Offline
compiler tests run with `yarn test:unit` (part of `yarn check`) and need no database. CI runs this suite on
local YDB 26.2.1.14 with two CPU cores and a 3 GB memory limit.

## Run the example

```bash
cp examples/basic/.env.example examples/basic/.env
yarn db:up
yarn db:migrate
yarn db:verify
yarn example:run
yarn db:down
```

YDB binds `127.0.0.1:2137`; monitoring binds `127.0.0.1:8766`.
`db:down` retains the Docker volume. The example removes its own rows after running.
Edit `examples/basic/prisma/contract.prisma`, then:

```bash
yarn db:migration:create --name add-field
yarn db:migration:check
yarn db:migrate
yarn example:generate
```

Review generated migration packages before applying them. Snapshots are generated;
the authored source remains `.prisma`.

## Commands

| Command                                               | Purpose                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `yarn test:unit`                                      | Run the offline compiler tests                               |
| `yarn test:integration`                               | Run the sequential live driver integration suite             |
| `yarn build`                                          | Build ESM and declarations                                   |
| `yarn lint`, `yarn typecheck`, `yarn check`           | Validate library and consumer                                |
| `yarn package:pack`                                   | Create an npm tarball in `artifacts/`                        |
| `yarn release:dry-run`                                | Run publication hooks without uploading                      |
| `yarn release:version 0.1.0-rc.1`                     | Update version/lockfile without commits or tags              |
| `yarn release:publish`                                | Publish to npm: prereleases use `next`, stable uses `latest` |
| `yarn example:generate`, `yarn example:run`           | Generate and run the consumer                                |
| `yarn db:migration:create --name change`              | Generate a migration from schema changes                     |
| `yarn db:migration:new --name change`                 | Scaffold a manual migration                                  |
| `yarn db:migration:check`                             | Validate the migration graph offline                         |
| `yarn db:migrate`, `yarn db:verify`, `yarn db:status` | Apply, verify and inspect migrations                         |
| `yarn db:infer`                                       | Write a separate inferred schema                             |
| `yarn db:up`, `yarn db:down`, `yarn db:logs`          | Manage local Docker YDB                                      |

## Documentation

- [Documentation index](packages/prisma-ydb/docs/README.md)
- [Installation and public API](packages/prisma-ydb/README.md)
- [Relations and referential integrity](packages/prisma-ydb/docs/relations.md)
- [Transactions and retries](packages/prisma-ydb/docs/transactions.md)
- [Native YQL and types](packages/prisma-ydb/docs/yql.md)
- [Shared selections and DTOs](packages/prisma-ydb/docs/selections.md)
- [Configuration and operations](packages/prisma-ydb/docs/operations.md)
- [Runtime, types, retries and limitations](packages/prisma-ydb/docs/api.md)
- [Migrations](packages/prisma-ydb/docs/migrations.md)
- [NestJS integration](packages/prisma-ydb/docs/nestjs.md)
- [Architecture](docs/architecture.md)
- [Publishing](docs/releasing.md)
- [Extraction origin](docs/ORIGIN.md)

YDB has no foreign keys. `relationMode: 'application'` retains ORM relations;
action-bearing relations apply client-side Cascade, SetNull or Restrict rules.
Raw writes bypass them; relations without actions remain unenforced metadata.
DDL is not transactional and savepoints are unsupported. Earlier application-repository results
do not certify this extracted release; qualify it against your workload.
