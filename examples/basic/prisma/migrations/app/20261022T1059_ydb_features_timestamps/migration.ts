import { YdbMigration, MigrationCLI } from 'prisma-ydb/control';

export default class YdbAuthoredMigration extends YdbMigration {
  override readonly spaceId = 'app';
  override describe() {
    return {
      from: 'd9b5980c8a70b67e8af44c665c7d0a58fb6a64e1d978fabe0e89c4e26830c04b',
      to: '9bf4a790068fb36d713d367cf1f227713bd87cd22d9df7668a5f7fa2ce125955',
    };
  }
  override get operations() {
    return [
      {
        id: 'table.Task.0',
        label: 'ALTER TABLE `Task` ALTER COLUMN `updatedAt` DROP DEFAULT',
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
              'ALTER TABLE `Task` ALTER COLUMN `updatedAt` DROP DEFAULT',
            sql: 'ALTER TABLE `Task` ALTER COLUMN `updatedAt` DROP DEFAULT',
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
              dueOn: {
                type: 'Date',
                nullable: true,
                default: null,
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
              status: {
                type: 'Utf8',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: 'TODO',
                },
              },
              title: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              updatedAt: {
                type: 'Timestamp',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: '1970-01-01T00:00:00.000000Z',
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
              dueOn: {
                type: 'Date',
                nullable: true,
                default: null,
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
              status: {
                type: 'Utf8',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: 'TODO',
                },
              },
              title: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              updatedAt: {
                type: 'Timestamp',
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
        },
      },
    ] as const;
  }
}

await MigrationCLI.run(import.meta.url, YdbAuthoredMigration);
