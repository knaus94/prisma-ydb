# prisma-ydb

Native YDB driver, ORM target and migrations for Prisma ORM 8. ESM, Node
`^24.11.0 || >=26.0.0`. Pinned to Prisma CLI `8.0.0-rc.24`, ORM platform
packages `8.0.0-rc.18`, and YDB JS SDK `6.3.1`.

This integration uses the Prisma 8 SQL-family API: `db.orm.Task`, reusable
fragments and generated contracts. The pinned release-candidate integration
needs qualification against your deployment workload.

## Install

After publication:

```bash
yarn add prisma-ydb@next @prisma/orm-family-sql@8.0.0-rc.18 @prisma/orm-framework@8.0.0-rc.18
yarn add -D prisma@8.0.0-rc.24
```

Before publication, replace `prisma-ydb@next` with the `.tgz` from the source
workspace's `yarn package:pack`. Explicit platform dependencies also let Prisma choose
public imports for generated TypeScript declarations.

## Configure

`prisma.config.ts`:

```ts
import { definePrismaConfig } from 'prisma/config';
import { defineYdbConfig } from 'prisma-ydb/config';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

export default definePrismaConfig({
  orm: defineYdbConfig({
    contract: './prisma/contract.prisma',
    relationMode: 'application',
    output: './src/generated',
    migrations: { dir: './prisma/migrations' },
    db: { connection: ydbBindingFromEnv() },
  }),
});
```

Set `YDB_CONNECTION_STRING=grpc://localhost:2137/local` locally, or the cluster's
`grpcs://` endpoint/database path. Load `.env` in your process if used, for example
with `import 'dotenv/config'` after installing `dotenv`. Authentication and TLS use
the official SDK environment provider.

`prisma/contract.prisma`:

```prisma
// use prisma-8
model Task {
  id        String   @id @default(uuid())
  title     String
  done      Boolean  @default(false)
  createdAt DateTime
}
```

```bash
yarn prisma contract emit
yarn prisma migration plan --name init
yarn prisma migration check
yarn prisma db migrate
yarn prisma db verify
```

Commit schema, migrations and their snapshots. Regenerate client contracts during build.

## Query and transact

```ts
import { ydb, Text } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import type { Contract } from './generated/contract.d.js';
import contractJson from './generated/contract.json' with { type: 'json' };

const db = ydb<Contract>({ contractJson, binding: ydbBindingFromEnv() });
await db.connect();
try {
  const summary = db.orm.Task.fragment((tasks) =>
    tasks.select('id', 'title', 'done'),
  );
  const task = await db.transaction(
    async (tx) => {
      const created = await tx.orm.Task.create({
        title: 'YDB',
        createdAt: new Date(),
      });
      await tx.yql(
        'DECLARE $id AS Utf8; UPDATE `Task` SET done = TRUE WHERE id = $id',
        { id: new Text(created.id) },
      );
      return tx.orm.Task.with(summary).where({ id: created.id }).first();
    },
    { retry: true },
  );
  console.log(task, await db.health(), db.stats());
} finally {
  await db.close();
}
```

Retries repeat the whole callback; external side effects must tolerate repetition.
Unknown commit outcomes require reconciliation. Values travel as parameters.

| Entry point              | Purpose                                           |
| ------------------------ | ------------------------------------------------- |
| `prisma-ydb`             | Factory, public types and native driver           |
| `prisma-ydb/runtime`     | ORM factory, codecs and typed YQL values          |
| `prisma-ydb/driver`      | Native driver, transactions, errors and streaming |
| `prisma-ydb/config`      | Official Prisma CLI configuration                 |
| `prisma-ydb/control`     | Migration authoring and control plane             |
| `prisma-ydb/environment` | SDK environment authentication/TLS                |

## Guides

Start with the [documentation index](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/README.md). Detailed guides cover
[relations and referential integrity](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/relations.md),
[migrations](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/migrations.md), [transactions and retries](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/transactions.md),
[native YQL](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/yql.md), [selections and DTOs](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/selections.md),
[NestJS](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/nestjs.md), [operations](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/operations.md) and the [API](https://github.com/knaus94/prisma-ydb/blob/main/packages/prisma-ydb/docs/api.md).
