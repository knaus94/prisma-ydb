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
