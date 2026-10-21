# NestJS integration

Use one client per process. The package has no Nest dependency.

```ts
import {
  Injectable,
  Module,
  OnModuleInit,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ydb } from 'prisma-ydb/runtime';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';
import type { Contract } from './generated/contract.d.js';
import contractJson from './generated/contract.json' with { type: 'json' };

@Injectable()
export class DatabaseService implements OnModuleInit, OnApplicationShutdown {
  readonly db = ydb<Contract>({
    contractJson,
    binding: ydbBindingFromEnv(),
    driverOptions: { closeTimeoutMs: 10_000 },
  });
  async onModuleInit() {
    await this.db.connect();
  }
  async onApplicationShutdown() {
    await this.db.close();
  }
}

@Module({ providers: [DatabaseService], exports: [DatabaseService] })
export class DatabaseModule {}
```

Enable `app.enableShutdownHooks()`. Set the process termination grace period
above `closeTimeoutMs`. Readiness returns HTTP 503 when
`(await database.db.health({ timeoutMs: 1000 })).ready` is false. From the start
of `close()`, readiness stays false while pending work drains.

Create shared fragments with `db.orm.Model.fragment((rows) => rows.select(...))`. Infer rows
with `CollectionRowOf<ReturnType<typeof fragment>>` from
`@prisma/orm-family-sql/orm-client`; DTO classes can `implements` the inferred type.
Both `db.orm.Model.with(fragment)` and `tx.orm.Model.with(fragment)` reuse it.
The basic example contains the complete selection → type → DTO chain. See
[shared selections and DTOs](selections.md) for the full pattern.

`implements` is a compile-time check. It does not instantiate DTOs, transform
JSON dates or add validation; use Nest validation/serialization where required.
