import {
  bool,
  int,
  list,
  optional,
  identifier,
  str,
  modelAttribute,
} from '@prisma/orm-framework/psl-parser';
import type { AuthoringModelAttributeContext } from '@prisma/orm-framework/components/authoring';
import { partitioning, changefeed, store } from './options.js';

function invalid(
  context: AuthoringModelAttributeContext,
  error: unknown,
): undefined {
  context.diagnostics?.push({
    code: 'YDB.MODEL_SETTINGS_INVALID',
    sourceId: context.sourceId ?? '<ydb>',
    message: error instanceof Error ? error.message : String(error),
  });
  return undefined;
}
export const ydbModelAttributes = {
  columnStore: {
    kind: 'modelAttribute' as const,
    attribute: 'columnStore',
    spec: () =>
      modelAttribute('columnStore', {
        documentation:
          'Column-oriented (OLAP) table hash-partitioned by its primary key; partition counts are creation-only.',
        named: {
          minPartitions: {
            type: optional(int({ min: 1 })),
            documentation: 'Initial minimum partitions.',
          },
          maxPartitions: {
            type: optional(int({ min: 1 })),
            documentation: 'Maximum partitions.',
          },
        },
      }),
    lower(
      parsed: Record<string, unknown>,
      context: AuthoringModelAttributeContext,
    ) {
      try {
        return {
          key: context.storageName,
          entity: {
            table: context.storageName,
            ...store(
              Object.fromEntries(
                Object.entries(parsed).filter(([, v]) => v !== undefined),
              ),
            ),
          },
        };
      } catch (error) {
        return invalid(context, error);
      }
    },
  },
  partitioning: {
    kind: 'modelAttribute' as const,
    attribute: 'partitioning',
    spec: () =>
      modelAttribute('partitioning', {
        documentation:
          'Managed row-table partitioning; uniformPartitions is creation-only.',
        named: {
          bySize: {
            type: optional(bool()),
            documentation: 'Size-based partitioning.',
          },
          byLoad: {
            type: optional(bool()),
            documentation: 'Load-based partitioning.',
          },
          minPartitions: {
            type: optional(int({ min: 1 })),
            documentation: 'Minimum partitions.',
          },
          maxPartitions: {
            type: optional(int({ min: 1 })),
            documentation: 'Maximum partitions.',
          },
          uniformPartitions: {
            type: optional(int({ min: 1 })),
            documentation:
              'Initial uniform partitions; unsigned leading key required.',
          },
        },
      }),
    lower(
      parsed: Record<string, unknown>,
      context: AuthoringModelAttributeContext,
    ) {
      try {
        return {
          key: context.storageName,
          entity: {
            table: context.storageName,
            ...partitioning(
              Object.fromEntries(
                Object.entries(parsed).filter(([, v]) => v !== undefined),
              ),
            ),
          },
        };
      } catch (error) {
        return invalid(context, error);
      }
    },
  },
  changefeed: {
    kind: 'modelAttribute' as const,
    attribute: 'changefeed',
    repeatable: true,
    spec: () =>
      modelAttribute('changefeed', {
        documentation: 'Managed changefeed and its consumers.',
        positional: [{ key: 'name', type: str(), documentation: 'Feed name.' }],
        named: {
          mode: {
            type: optional(identifier()),
            documentation:
              'KeysOnly, Updates, NewImage, OldImage or NewAndOldImages.',
          },
          format: {
            type: optional(identifier()),
            documentation: 'Json or DebeziumJson.',
          },
          retention: {
            type: optional(str()),
            documentation: 'Whole-day/hour/minute/second ISO duration.',
          },
          partitions: {
            type: optional(int({ min: 1 })),
            documentation:
              'Initial topic partitions; unsigned leading key required.',
          },
          autoPartitioning: {
            type: optional(bool()),
            documentation: 'Enable topic partition growth.',
          },
          consumers: {
            type: optional(list(str(), { unique: true })),
            documentation: 'Managed consumer names.',
          },
        },
      }),
    lower(
      parsed: Record<string, unknown>,
      context: AuthoringModelAttributeContext,
    ) {
      try {
        const feed = changefeed(
          Object.fromEntries(
            Object.entries(parsed).filter(([, v]) => v !== undefined),
          ),
        );
        return {
          key: context.storageName + '/' + feed.name,
          entity: { table: context.storageName, ...feed },
        };
      } catch (error) {
        return invalid(context, error);
      }
    },
  },
};
