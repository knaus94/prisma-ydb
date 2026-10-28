# Shared selections, inferred types and DTOs

A fragment describes a reusable selection in the Prisma 8 SQL-family API.
Define fields and includes once, infer the result type, and check DTO classes
with `implements`. The source workspace contains a compiling example in
`examples/basic/src/selections.ts` and `dto.ts`.

## Define selections

For the `Project` and `Task` schema in the [relations guide](relations.md):

```ts
import type { CollectionRowOf } from '@prisma/orm-family-sql/orm-client';
import type { YdbClient } from 'prisma-ydb/runtime';
import type { Contract } from './generated/contract.d.js';

export function createSelections(orm: YdbClient<Contract>['orm']) {
  const project = orm.Project.fragment((projects) =>
    projects.select('id', 'name'),
  );
  const task = orm.Task.fragment((tasks) =>
    tasks.select('id', 'title', 'done', 'createdAt'),
  );
  const fullTask = orm.Task.fragment((tasks) =>
    tasks.with(task).include('project', (projects) => projects.with(project)),
  );
  return { project, task, fullTask };
}

type Selections = ReturnType<typeof createSelections>;
export type ProjectRow = CollectionRowOf<ReturnType<Selections['project']>>;
export type TaskRow = CollectionRowOf<ReturnType<Selections['task']>>;
export type FullTaskRow = CollectionRowOf<ReturnType<Selections['fullTask']>>;
```

Call `.fragment(callback)` on the model collection. Defining a fragment performs
no query. `.with(fragment)` applies its transformation to a collection; terminal
operations such as `.all()` and `.first()` execute the query.

## Define DTOs

```ts
import type { FullTaskRow, ProjectRow, TaskRow } from './selections.js';

export class ProjectDto implements ProjectRow {
  id!: string;
  name!: string;
}
export class TaskDto implements TaskRow {
  id!: string;
  title!: string;
  done!: boolean;
  createdAt!: Date;
}
export class FullTaskDto extends TaskDto implements FullTaskRow {
  project!: ProjectDto | null;
}
```

`implements` checks compatibility when selection fields or types change.
TypeScript permits additional DTO properties: this is not an exact-key check.
Add Swagger or validation decorators in your application if needed; the package
has no Nest dependency.

`implements` does not instantiate a DTO or validate data at runtime. If your
serializer requires class instances, construct them explicitly, including nested
objects. A JavaScript `Date` and the string emitted in an HTTP JSON response are
different representations. Optional relations return `null`; to-many relations
return arrays, including empty arrays. A required relation type does not enforce
a reference in YDB.

## Use selections in services and transactions

```ts
const select = createSelections(db.orm);

const rows = await db.orm.Task.with(select.fullTask)
  .where({ done: false })
  .limit(50)
  .all();

const row = await db.transaction(async (tx) => {
  await tx.orm.Task.where({ id: taskId }).updateAndCount({ done: true });
  return tx.orm.Task.with(select.fullTask).where({ id: taskId }).first();
});
```

Reuse the same fragments with the root client and `tx.orm` for the same contract.
Build fragment expressions from the supplied builder; do not perform a separate
query through a captured root client inside the fragment.

Fragments reuse query descriptions. For frequently executed queries,
`db.prepare(declaration, callback)` additionally reuses compilation and decoder
setup while binding values per call. It does not expose a server-side prepared
statement handle. Parameter declarations follow the pinned Prisma API.

See [NestJS integration](nestjs.md), [relations](relations.md) and the
[pinned Prisma ORM API](https://github.com/prisma/orm/blob/v8.0.0-rc.18/packages/3-extensions/sql-orm-client/README.md).

For example, a prepared selection can execute on the client or a live transaction:

```ts
const byId = await db.prepare(
  { id: 'ydb/utf8@1' } as const,
  (p) => db.orm.Task.with(select.task).where((row) => row.id.eq(p.id)).prepared.first(),
);
const task = await byId.query(db, { id: taskId });
await db.transaction(async (tx) => {
  const sameSnapshot = await byId.query(tx, { id: taskId });
});
```

Use `'ydb/uuid@1'` when the selected field is authored as `Uuid`. Prepared
execution uses the target's runtime pipeline; a settled transaction or closed
client rejects the call. DTO UUID properties stay `string`.
