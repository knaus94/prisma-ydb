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
