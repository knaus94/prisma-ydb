import type { FullTaskRow, ProjectRow, TaskRow } from './selections.js';

export class ProjectDto implements ProjectRow {
  id!: string;
  name!: string;
  budget!: ProjectRow['budget'];
  tags!: ProjectRow['tags'];
  settings!: ProjectRow['settings'];
}

export class TaskDto implements TaskRow {
  id!: string;
  title!: string;
  done!: boolean;
  status!: TaskRow['status'];
  createdAt!: Date;
  updatedAt!: Date;
  dueOn!: TaskRow['dueOn'];
}

export class FullTaskDto extends TaskDto implements FullTaskRow {
  project!: ProjectDto | null;
}
