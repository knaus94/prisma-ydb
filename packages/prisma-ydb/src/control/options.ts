import { CrossReferenceSchema } from '@prisma/orm-framework/contract/types';
import type { SqlNamespaceInput } from '@prisma/orm-family-sql/contract/types';
import {
  quoteYdbIdentifier as q,
  ydbDuration,
  ydbDurationSeconds,
} from './literals.js';

export interface YdbPartitioning {
  bySize?: boolean;
  byLoad?: boolean;
  minPartitions?: number;
  maxPartitions?: number;
  uniformPartitions?: number;
  /** Observed live count, not an authored setting. */
  observedPartitions?: number;
}
export interface YdbChangefeed {
  name: string;
  mode: string;
  format: string;
  retentionSeconds: number;
  partitions?: number;
  autoPartitioning: boolean;
  consumers: string[];
}
export interface YdbTableOptions {
  partitioning?: YdbPartitioning;
  changefeeds?: YdbChangefeed[];
}
const modes: Record<string, string> = {
  KeysOnly: 'KEYS_ONLY',
  Updates: 'UPDATES',
  NewImage: 'NEW_IMAGE',
  OldImage: 'OLD_IMAGE',
  NewAndOldImages: 'NEW_AND_OLD_IMAGES',
};
const formats: Record<string, string> = {
  Json: 'JSON',
  DebeziumJson: 'DEBEZIUM_JSON',
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a YDB settings object.');
  return value as Record<string, unknown>;
}
function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error(name + ' must be a positive safe integer.');
  return value;
}
function boolean(value: unknown, name: string): boolean {
  if (value === 'ENABLED') return true;
  if (value === 'DISABLED') return false;
  if (typeof value !== 'boolean') throw new Error(name + ' must be boolean.');
  return value;
}
function name(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    Buffer.byteLength(value) > 255 ||
    /[\p{Cc}/]/u.test(value)
  )
    throw new Error('Invalid YDB changefeed/consumer name.');
  return value;
}
export function partitioning(value: unknown): YdbPartitioning {
  const input = record(value),
    result: YdbPartitioning = {};
  for (const key of Object.keys(input)) {
    if (key === 'bySize' || key === 'byLoad')
      result[key] = boolean(input[key], key);
    else if (
      key === 'minPartitions' ||
      key === 'maxPartitions' ||
      key === 'uniformPartitions'
    )
      result[key] = positive(input[key], key);
    else throw new Error('Unknown YDB partitioning setting: ' + key);
  }
  if (
    result.uniformPartitions !== undefined &&
    result.minPartitions === undefined
  )
    result.minPartitions = result.uniformPartitions;
  if (
    result.maxPartitions !== undefined &&
    (result.minPartitions ?? 1) > result.maxPartitions
  )
    throw new Error('minPartitions exceeds maxPartitions.');
  if (
    result.uniformPartitions !== undefined &&
    result.uniformPartitions > (result.minPartitions ?? 1)
  )
    throw new Error(
      'minPartitions must preserve the initial uniform partitions.',
    );
  if (
    result.maxPartitions !== undefined &&
    (result.uniformPartitions ?? 1) > result.maxPartitions
  )
    throw new Error('uniformPartitions exceeds maxPartitions.');
  return result;
}
export function changefeed(value: unknown): YdbChangefeed {
  const input = record(value);
  for (const key of Object.keys(input))
    if (
      ![
        'name',
        'mode',
        'format',
        'retention',
        'retentionSeconds',
        'partitions',
        'autoPartitioning',
        'consumers',
      ].includes(key)
    )
      throw new Error('Unknown YDB changefeed setting: ' + key);
  const mode = modes[String(input.mode)] ?? input.mode ?? 'NEW_IMAGE';
  const format = formats[String(input.format)] ?? input.format ?? 'JSON';
  if (!Object.values(modes).includes(String(mode)))
    throw new Error('Unsupported YDB changefeed mode.');
  if (!Object.values(formats).includes(String(format)))
    throw new Error('Unsupported YDB changefeed format.');
  const seconds =
    input.retentionSeconds ??
    (typeof input.retention === 'string'
      ? ydbDurationSeconds(input.retention)
      : 86400);
  if (
    typeof seconds !== 'number' ||
    !Number.isSafeInteger(seconds) ||
    seconds < 1 ||
    seconds > 2592000
  )
    throw new Error(
      'Changefeed retention must be between one second and thirty days.',
    );
  const consumers = input.consumers ?? [];
  if (!Array.isArray(consumers)) throw new Error('consumers must be a list.');
  const names = consumers.map(name).sort();
  if (new Set(names).size !== names.length)
    throw new Error('Duplicate changefeed consumer.');
  return {
    name: name(input.name),
    mode: String(mode),
    format: String(format),
    retentionSeconds: seconds,
    ...(input.partitions !== undefined
      ? { partitions: positive(input.partitions, 'partitions') }
      : {}),
    autoPartitioning:
      input.autoPartitioning === undefined
        ? false
        : boolean(input.autoPartitioning, 'autoPartitioning'),
    consumers: names,
  };
}
export function tableOptions(table: unknown): YdbTableOptions {
  const value = record(table);
  const annotations = value.annotations as Record<string, unknown> | undefined;
  return (annotations?.['ydb'] ?? {}) as YdbTableOptions;
}
export function optionsForTable(
  namespace: { entries: Record<string, unknown> },
  table: string,
): YdbTableOptions {
  const entries = namespace.entries['ydb_options'] as
    | Record<string, { annotations: { ydb: YdbTableOptions } }>
    | undefined;
  return canonicalOptions(entries?.[table]?.annotations.ydb ?? {});
}
function canonicalOptions(value: unknown): YdbTableOptions {
  const raw = record(value);
  if (raw.changefeeds !== undefined && !Array.isArray(raw.changefeeds))
    throw new Error('changefeeds must be a list');
  if (
    Array.isArray(raw.changefeeds) &&
    new Set(raw.changefeeds.map((item) => changefeed(item).name)).size !==
      raw.changefeeds.length
  )
    throw new Error('Duplicate changefeed name');
  for (const key of Object.keys(raw))
    if (!['partitioning', 'changefeeds'].includes(key))
      throw new Error('Unknown YDB table annotation: ' + key);
  return {
    ...(raw.partitioning
      ? { partitioning: partitioning(raw.partitioning) }
      : {}),
    ...(raw.changefeeds
      ? {
          changefeeds: (raw.changefeeds as unknown[])
            .map(changefeed)
            .sort((a, b) => a.name.localeCompare(b.name)),
        }
      : {}),
  };
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) frozen(item);
    Object.freeze(value);
  }
  return value;
}
function storedOptions(options: YdbTableOptions): Record<string, unknown> {
  const flag = (value: boolean) => (value ? 'ENABLED' : 'DISABLED');
  return {
    ...(options.partitioning
      ? {
          partitioning: {
            ...options.partitioning,
            ...(options.partitioning.bySize !== undefined
              ? { bySize: flag(options.partitioning.bySize) }
              : {}),
            ...(options.partitioning.byLoad !== undefined
              ? { byLoad: flag(options.partitioning.byLoad) }
              : {}),
          },
        }
      : {}),
    ...(options.changefeeds
      ? {
          changefeeds: options.changefeeds.map((feed) => ({
            ...feed,
            autoPartitioning: flag(feed.autoPartitioning),
          })),
        }
      : {}),
  };
}
export const ydbOptionsKind = {
  kind: 'ydb_options',
  schema: CrossReferenceSchema.or('unknown').narrow((value, ctx) => {
    try {
      const row = record(value);
      if (typeof row.table !== 'string') return ctx.mustBe('YDB table options');
      canonicalOptions(tableOptions(row));
      return true;
    } catch {
      return ctx.mustBe('canonical annotations.ydb table options');
    }
  }),
  construct: (value: unknown) => {
    const row = record(value);
    return frozen({
      table: String(row.table),
      annotations: { ydb: storedOptions(canonicalOptions(tableOptions(row))) },
    });
  },
};
/** Lower authoring entities into the one persisted annotations.ydb subtree before hashing. */
export function normalizeYdbOptions(
  input: SqlNamespaceInput,
): SqlNamespaceInput {
  const entries = { ...input.entries };
  const byTable = new Map<string, YdbTableOptions>();
  for (const [key, value] of Object.entries(entries['ydb_options'] ?? {})) {
    const row = record(value);
    if (row.table !== key || !entries.table?.[key])
      throw new Error('Orphan or mismapped YDB options: ' + key);
  }
  for (const table of Object.keys(entries.table ?? {})) {
    const raw = optionsForTable({ entries }, table);
    byTable.set(table, {
      ...(raw.partitioning
        ? { partitioning: partitioning(raw.partitioning) }
        : {}),
      ...(raw.changefeeds
        ? {
            changefeeds: raw.changefeeds
              .map(changefeed)
              .sort((a, b) => a.name.localeCompare(b.name)),
          }
        : {}),
    });
  }
  for (const value of Object.values(entries['partitioning'] ?? {})) {
    const row = record(value),
      table = String(row.table),
      options = byTable.get(table);
    if (!options)
      throw new Error('Partitioning refers to missing table ' + table);
    const settings = { ...row };
    delete settings.table;
    if (options.partitioning)
      throw new Error('Duplicate partitioning for ' + table);
    options.partitioning = partitioning(settings);
  }
  for (const value of Object.values(entries['changefeed'] ?? {})) {
    const row = record(value),
      table = String(row.table),
      options = byTable.get(table);
    if (!options)
      throw new Error('Changefeed refers to missing table ' + table);
    const settings = { ...row };
    delete settings.table;
    const feed = changefeed(settings);
    options.changefeeds ??= [];
    if (options.changefeeds.some((item) => item.name === feed.name))
      throw new Error('Duplicate changefeed ' + table + '/' + feed.name);
    options.changefeeds.push(feed);
    options.changefeeds.sort((a, b) => a.name.localeCompare(b.name));
  }
  delete entries['partitioning'];
  delete entries['changefeed'];
  entries['ydb_options'] = Object.fromEntries(
    [...byTable]
      .filter(
        ([, options]) => options.partitioning || options.changefeeds?.length,
      )
      .map(([table, options]) => [
        table,
        { table, annotations: { ydb: options } },
      ]),
  );
  if (!Object.keys(entries['ydb_options'] as object).length)
    delete entries['ydb_options'];
  return { ...input, entries };
}
export function renderPartitioning(
  settings: YdbPartitioning,
  create: boolean,
): string[] {
  const sql: string[] = [];
  if (settings.bySize !== undefined)
    sql.push(
      'AUTO_PARTITIONING_BY_SIZE = ' +
        (settings.bySize ? 'ENABLED' : 'DISABLED'),
    );
  if (settings.byLoad !== undefined)
    sql.push(
      'AUTO_PARTITIONING_BY_LOAD = ' +
        (settings.byLoad ? 'ENABLED' : 'DISABLED'),
    );
  if (settings.minPartitions !== undefined)
    sql.push(
      'AUTO_PARTITIONING_MIN_PARTITIONS_COUNT = ' + settings.minPartitions,
    );
  if (settings.maxPartitions !== undefined)
    sql.push(
      'AUTO_PARTITIONING_MAX_PARTITIONS_COUNT = ' + settings.maxPartitions,
    );
  if (create && settings.uniformPartitions !== undefined)
    sql.push('UNIFORM_PARTITIONS = ' + settings.uniformPartitions);
  return sql;
}
export function addChangefeedSql(table: string, feed: YdbChangefeed): string {
  return (
    'ALTER TABLE ' +
    q(table) +
    ' ADD CHANGEFEED ' +
    q(feed.name) +
    ' WITH (MODE = ' +
    JSON.stringify(feed.mode) +
    ', FORMAT = ' +
    JSON.stringify(feed.format) +
    ', RETENTION_PERIOD = Interval(' +
    JSON.stringify(ydbDuration(feed.retentionSeconds)) +
    ')' +
    (feed.partitions !== undefined
      ? ', TOPIC_MIN_ACTIVE_PARTITIONS = ' + feed.partitions
      : '') +
    ', TOPIC_AUTO_PARTITIONING = ' +
    JSON.stringify(feed.autoPartitioning ? 'ENABLED' : 'DISABLED') +
    ')'
  );
}
export function topicConsumerSql(
  table: string,
  feed: string,
  consumer: string,
  add: boolean,
): string {
  return (
    'ALTER TOPIC ' +
    q(table + '/' + feed) +
    (add ? ' ADD CONSUMER ' : ' DROP CONSUMER ') +
    q(consumer)
  );
}
/** Match only authored partition knobs; feeds/consumers are owned as a complete set. */
export function matchesOptions(
  actual: YdbTableOptions,
  expected: YdbTableOptions,
): boolean {
  if (expected.partitioning)
    for (const [key, value] of Object.entries(expected.partitioning)) {
      if (key === 'uniformPartitions') {
        if (
          (actual.partitioning?.observedPartitions ??
            actual.partitioning?.uniformPartitions ??
            0) < Number(value)
        )
          return false;
      } else if (actual.partitioning?.[key as keyof YdbPartitioning] !== value)
        return false;
    }
  const left = actual.changefeeds ?? [],
    right = expected.changefeeds ?? [];
  if (left.length !== right.length) return false;
  return right.every((wanted) => {
    const live = left.find((feed) => feed.name === wanted.name);
    return (
      !!live &&
      live.mode === wanted.mode &&
      live.format === wanted.format &&
      live.retentionSeconds === wanted.retentionSeconds &&
      live.autoPartitioning === wanted.autoPartitioning &&
      (wanted.partitions === undefined ||
        (wanted.autoPartitioning
          ? (live.partitions ?? 0) >= wanted.partitions
          : live.partitions === wanted.partitions)) &&
      JSON.stringify(live.consumers) === JSON.stringify(wanted.consumers)
    );
  });
}

export async function readTableOptions(
  core: import('@ydbjs/core').Driver,
  table: import('@ydbjs/api/table').DescribeTableResult,
  path: string,
): Promise<YdbTableOptions> {
  const {
    TopicServiceDefinition,
    DescribeTopicResultSchema,
    AutoPartitioningStrategy,
  } = await import('@ydbjs/api/topic');
  const { ChangefeedMode_Mode, ChangefeedFormat_Format } =
    await import('@ydbjs/api/table');
  const { StatusIds_StatusCode } = await import('@ydbjs/api/operation');
  const { anyUnpack } = await import('@bufbuild/protobuf/wkt');
  const settings = table.partitioningSettings;
  const partition: YdbPartitioning = {
    ...(settings?.partitioningBySize
      ? { bySize: settings.partitioningBySize === 1 }
      : {}),
    ...(settings?.partitioningByLoad
      ? { byLoad: settings.partitioningByLoad === 1 }
      : {}),
    minPartitions: Number(settings?.minPartitionsCount || 1n),
    ...(settings?.maxPartitionsCount
      ? { maxPartitions: Number(settings.maxPartitionsCount) }
      : {}),
    ...(table.tableStats
      ? { observedPartitions: Number(table.tableStats.partitions) }
      : {}),
  };
  const topics = core.createClient(TopicServiceDefinition),
    feeds: YdbChangefeed[] = [];
  for (const description of table.changefeeds) {
    const response = await topics.describeTopic(
      { path: core.database + '/' + path + '/' + description.name },
      { signal: AbortSignal.timeout(30000) },
    );
    const op = response.operation;
    if (!op?.ready || op.status !== StatusIds_StatusCode.SUCCESS || !op.result)
      throw new Error(
        'Cannot describe YDB changefeed topic ' + path + '/' + description.name,
      );
    const topic = anyUnpack(op.result, DescribeTopicResultSchema);
    if (!topic?.retentionPeriod || topic.retentionPeriod.nanos !== 0)
      throw new Error('Invalid or fractional YDB topic retention.');
    const strategy =
      topic.partitioningSettings?.autoPartitioningSettings?.strategy;
    if (
      strategy !== AutoPartitioningStrategy.DISABLED &&
      strategy !== AutoPartitioningStrategy.SCALE_UP &&
      strategy !== AutoPartitioningStrategy.SCALE_UP_AND_DOWN
    )
      throw new Error(
        'Unsupported or paused topic partitioning strategy: ' +
          path +
          '/' +
          description.name,
      );
    feeds.push({
      name: description.name,
      mode: ChangefeedMode_Mode[description.mode]!,
      format: ChangefeedFormat_Format[description.format]!,
      retentionSeconds: Number(topic.retentionPeriod.seconds),
      partitions: topic.partitions.filter((partition) => partition.active)
        .length,
      autoPartitioning: strategy !== AutoPartitioningStrategy.DISABLED,
      consumers: topic.consumers.map((consumer) => consumer.name).sort(),
    });
  }
  return {
    partitioning: partition,
    changefeeds: feeds.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
