import { YdbMigration, MigrationCLI } from 'prisma-ydb/control';

export default class YdbAuthoredMigration extends YdbMigration {
  override readonly spaceId = 'app';
  override describe() {
    return {
      from: 'edb823ca65f272c0f5af57fea6d9fc044a6ce25b440fbf6d696a5a6af767aa9e',
      to: '188f82da8b88da5ab6bb5f3e9acb9d73a9976a0c9fd9c735c0de4e03af56ae28',
    };
  }
  override get operations() {
    return [
      {
        id: 'table.Task.0',
        label: 'ALTER TABLE `Task` ADD COLUMN `status` Utf8 NOT NULL DEFAULT Utf8("TODO")',
        operationClass: 'additive',
        target: {
          id: 'ydb',
          details: {
            table: 'Task',
          },
        },
        precheck: [],
        execute: [
          {
            description:
              'ALTER TABLE `Task` ADD COLUMN `status` Utf8 NOT NULL DEFAULT Utf8("TODO")',
            sql: 'ALTER TABLE `Task` ADD COLUMN `status` Utf8 NOT NULL DEFAULT Utf8("TODO")',
          },
        ],
        postcheck: [],
        meta: {
          ydbBefore: {
            columns: {
              createdAt: {
                type: 'Timestamp',
                nullable: false,
                default: null,
              },
              done: {
                type: 'Bool',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: false,
                },
              },
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              projectId: {
                type: 'Utf8',
                nullable: true,
                default: null,
              },
              title: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [
              {
                name: 'Task_projectId_idx_a96e4d92',
                columns: ['projectId'],
                unique: false,
              },
            ],
            uniques: [],
          },
          ydbAfter: {
            columns: {
              createdAt: {
                type: 'Timestamp',
                nullable: false,
                default: null,
              },
              done: {
                type: 'Bool',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: false,
                },
              },
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              projectId: {
                type: 'Utf8',
                nullable: true,
                default: null,
              },
              title: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              status: {
                type: 'Utf8',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: 'TODO',
                },
              },
            },
            primaryKey: ['id'],
            indexes: [
              {
                name: 'Task_projectId_idx_a96e4d92',
                columns: ['projectId'],
                unique: false,
              },
            ],
            uniques: [],
          },
        },
      },
    ] as const;
  }
}

await MigrationCLI.run(import.meta.url, YdbAuthoredMigration);
