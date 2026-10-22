import {
  YdbMigration,
  MigrationCLI,
  ydbDataOperation,
} from 'prisma-ydb/control';

export default class YdbAuthoredMigration extends YdbMigration {
  override readonly spaceId = 'app';
  override describe() {
    return {
      from: '188f82da8b88da5ab6bb5f3e9acb9d73a9976a0c9fd9c735c0de4e03af56ae28',
      to: 'd9b5980c8a70b67e8af44c665c7d0a58fb6a64e1d978fabe0e89c4e26830c04b',
    };
  }
  override get operations() {
    return [
      {
        id: 'table.AuditEvent.0',
        label:
          'CREATE TABLE `AuditEvent` (`action` Utf8 NOT NULL, `at` Timestamp NOT NULL, `id` Utf8 NOT NULL, PRIMARY KEY (`id`)) WITH (TTL = Interval("PT2592000S") ON `at`)',
        operationClass: 'additive',
        target: {
          id: 'ydb',
          details: {
            table: 'AuditEvent',
          },
        },
        precheck: [],
        execute: [
          {
            description:
              'CREATE TABLE `AuditEvent` (`action` Utf8 NOT NULL, `at` Timestamp NOT NULL, `id` Utf8 NOT NULL, PRIMARY KEY (`id`)) WITH (TTL = Interval("PT2592000S") ON `at`)',
            sql: 'CREATE TABLE `AuditEvent` (`action` Utf8 NOT NULL, `at` Timestamp NOT NULL, `id` Utf8 NOT NULL, PRIMARY KEY (`id`)) WITH (TTL = Interval("PT2592000S") ON `at`)',
          },
        ],
        postcheck: [],
        meta: {
          ydbBefore: null,
          ydbAfter: {
            ttl: {
              column: 'at',
              expireAfterSeconds: 2592000,
              table: 'AuditEvent',
            },
            columns: {
              action: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              at: {
                type: 'Timestamp',
                nullable: false,
                default: null,
              },
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
        },
      },
      {
        id: 'table.Project.1',
        label: 'ALTER TABLE `Project` ADD COLUMN `budget` Decimal(12,2)',
        operationClass: 'additive',
        target: {
          id: 'ydb',
          details: {
            table: 'Project',
          },
        },
        precheck: [],
        execute: [
          {
            description:
              'ALTER TABLE `Project` ADD COLUMN `budget` Decimal(12,2)',
            sql: 'ALTER TABLE `Project` ADD COLUMN `budget` Decimal(12,2)',
          },
        ],
        postcheck: [],
        meta: {
          ydbBefore: {
            columns: {
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              name: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
          ydbAfter: {
            columns: {
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              name: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              budget: {
                type: 'Decimal(12,2)',
                nullable: true,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
        },
      },
      {
        id: 'table.Project.2',
        label: 'ALTER TABLE `Project` ADD COLUMN `settings` Json',
        operationClass: 'additive',
        target: {
          id: 'ydb',
          details: {
            table: 'Project',
          },
        },
        precheck: [],
        execute: [
          {
            description: 'ALTER TABLE `Project` ADD COLUMN `settings` Json',
            sql: 'ALTER TABLE `Project` ADD COLUMN `settings` Json',
          },
        ],
        postcheck: [],
        meta: {
          ydbBefore: {
            columns: {
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              name: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              budget: {
                type: 'Decimal(12,2)',
                nullable: true,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
          ydbAfter: {
            columns: {
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              name: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              budget: {
                type: 'Decimal(12,2)',
                nullable: true,
                default: null,
              },
              settings: {
                type: 'Json',
                nullable: true,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
        },
      },
      {
        id: 'table.Project.3',
        label:
          'ALTER TABLE `Project` ADD COLUMN `tags` Json NOT NULL DEFAULT Json("[]")',
        operationClass: 'additive',
        target: {
          id: 'ydb',
          details: {
            table: 'Project',
          },
        },
        precheck: [],
        execute: [
          {
            description:
              'ALTER TABLE `Project` ADD COLUMN `tags` Json NOT NULL DEFAULT Json("[]")',
            sql: 'ALTER TABLE `Project` ADD COLUMN `tags` Json NOT NULL DEFAULT Json("[]")',
          },
        ],
        postcheck: [],
        meta: {
          ydbBefore: {
            columns: {
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              name: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              budget: {
                type: 'Decimal(12,2)',
                nullable: true,
                default: null,
              },
              settings: {
                type: 'Json',
                nullable: true,
                default: null,
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
          ydbAfter: {
            columns: {
              id: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              name: {
                type: 'Utf8',
                nullable: false,
                default: null,
              },
              budget: {
                type: 'Decimal(12,2)',
                nullable: true,
                default: null,
              },
              settings: {
                type: 'Json',
                nullable: true,
                default: null,
              },
              tags: {
                type: 'Json',
                nullable: false,
                default: {
                  kind: 'literal',
                  value: [],
                },
              },
            },
            primaryKey: ['id'],
            indexes: [],
            uniques: [],
          },
        },
      },
      {
        id: 'table.Task.4',
        label: 'ALTER TABLE `Task` ADD COLUMN `dueOn` Date',
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
            description: 'ALTER TABLE `Task` ADD COLUMN `dueOn` Date',
            sql: 'ALTER TABLE `Task` ADD COLUMN `dueOn` Date',
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
              dueOn: {
                type: 'Date',
                nullable: true,
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
      {
        id: 'table.Task.5',
        label:
          'ALTER TABLE `Task` ADD COLUMN `updatedAt` Timestamp NOT NULL DEFAULT Timestamp("1970-01-01T00:00:00.000000Z")',
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
              'ALTER TABLE `Task` ADD COLUMN `updatedAt` Timestamp NOT NULL DEFAULT Timestamp("1970-01-01T00:00:00.000000Z")',
            sql: 'ALTER TABLE `Task` ADD COLUMN `updatedAt` Timestamp NOT NULL DEFAULT Timestamp("1970-01-01T00:00:00.000000Z")',
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
              dueOn: {
                type: 'Date',
                nullable: true,
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
              dueOn: {
                type: 'Date',
                nullable: true,
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
        },
      },
      ydbDataOperation({
        id: 'data.Task.backfill_updatedAt',
        table: 'Task',
        label: 'Backfill Task.updatedAt from createdAt',
        sql: 'UPDATE `Task` SET updatedAt = createdAt',
        verifySql:
          'SELECT COUNT(*) = 0 AS ok FROM `Task` WHERE updatedAt != createdAt',
      }),
    ] as const;
  }
}

await MigrationCLI.run(import.meta.url, YdbAuthoredMigration);
