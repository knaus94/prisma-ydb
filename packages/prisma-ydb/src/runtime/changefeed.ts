import { createTopicReader } from '@ydbjs/topic/reader';
import type { TopicMessage } from '@ydbjs/topic/message';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type { JsonValue } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import type { YdbDriver } from '../driver/driver.js';
import { decodeYdbJson } from './codecs.js';
import { resolveModel, type ModelColumn, type ResolvedModel } from './model.js';

export interface YdbChangefeedOptions {
  /** Topic consumer; declare it in `@@changefeed(consumers: [...])` or create it manually. */
  readonly consumer: string;
  /** Required when the model declares more than one changefeed. */
  readonly feed?: string;
  readonly signal?: AbortSignal;
  /** Maximum messages per batch. */
  readonly limit?: number;
  /** How long one read waits for messages before yielding what it has. */
  readonly waitMs?: number;
  readonly partitionIds?: readonly bigint[];
  readonly readFrom?: Date;
  /** Skip messages older than this many milliseconds. */
  readonly maxLagMs?: number;
  readonly maxBufferBytes?: bigint;
}

export interface YdbChangeEvent<Row = Record<string, unknown>> {
  readonly kind: 'update' | 'erase';
  /** Primary key fields of the affected row. */
  readonly key: Partial<Row>;
  /** Changed fields (`Updates` mode); the key fields are not repeated here. */
  readonly updates?: Partial<Row>;
  readonly newImage?: Row;
  readonly oldImage?: Row;
  /** Virtual timestamp `[step, txId]` when the feed records it. */
  readonly ts?: readonly [bigint, bigint];
  readonly offset: bigint | undefined;
  readonly partition: bigint | undefined;
  readonly seqNo: bigint;
  readonly writtenAt: Date | undefined;
  /** The decoded JSON record exactly as the server sent it. */
  readonly raw: JsonValue;
}

export interface YdbChangeBatch<Row = Record<string, unknown>> {
  readonly events: readonly YdbChangeEvent<Row>[];
  /** Acknowledge the batch; the consumer resumes after it on restart. */
  commit(): Promise<void>;
}

const integerCodecs = new Set(['ydb/int64@1', 'ydb/uint64@1', 'ydb/number@1']);

/** Changefeed JSON is YDB's own encoding; align it with the codec JSON forms. */
function normalize(column: ModelColumn, value: JsonValue): JsonValue {
  if (integerCodecs.has(column.codecId) || column.codecId === 'ydb/decimal@1')
    return typeof value === 'number' ? String(value) : value;
  if (column.codecId === 'ydb/json@1' || column.many)
    return typeof value === 'string' ? (JSON.parse(value) as JsonValue) : value;
  return value;
}

function decodeField(column: ModelColumn, value: JsonValue): unknown {
  if (value === null) return null;
  const json = normalize(column, value);
  if (column.many) {
    if (!Array.isArray(json))
      throw new TypeError(
        `Changefeed list column ${column.column} is not an array`,
      );
    return json.map((element) =>
      decodeYdbJson(column.codecId, element, column.typeParams),
    );
  }
  return decodeYdbJson(column.codecId, json, column.typeParams);
}

function decodeImage(
  model: ResolvedModel,
  image: JsonValue,
): Record<string, unknown> {
  if (typeof image !== 'object' || image === null || Array.isArray(image))
    throw new TypeError('Changefeed image is not an object');
  const row: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(image)) {
    const column = model.byColumn.get(name);
    if (column) row[column.field] = decodeField(column, value);
  }
  return row;
}

function decodeKey(
  model: ResolvedModel,
  key: JsonValue,
): Record<string, unknown> {
  if (!Array.isArray(key) || key.length !== model.primaryKey.length)
    throw new TypeError('Changefeed key does not match the primary key');
  const row: Record<string, unknown> = {};
  model.primaryKey.forEach((column, index) => {
    row[column.field] = decodeField(column, key[index] as JsonValue);
  });
  return row;
}

function decodeMessage(
  model: ResolvedModel,
  message: TopicMessage,
): YdbChangeEvent {
  const raw = JSON.parse(
    new TextDecoder().decode(message.payload),
  ) as JsonValue;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new TypeError('Changefeed record is not an object');
  const record = raw as Record<string, JsonValue>;
  const ts = record['ts'];
  const key = decodeKey(model, record['key'] ?? null);
  // Images carry non-key columns only; merge the key so they read as full rows.
  const image = (name: string) =>
    name in record && record[name] !== null
      ? { ...key, ...decodeImage(model, record[name] ?? {}) }
      : undefined;
  const newImage = image('newImage');
  const oldImage = image('oldImage');
  return {
    kind: 'erase' in record ? 'erase' : 'update',
    key,
    ...('update' in record && record['update'] !== null
      ? { updates: decodeImage(model, record['update'] ?? {}) }
      : {}),
    ...(newImage ? { newImage } : {}),
    ...(oldImage ? { oldImage } : {}),
    ...(Array.isArray(ts) && ts.length === 2
      ? { ts: [BigInt(ts[0] as number), BigInt(ts[1] as number)] as const }
      : {}),
    offset: message.offset,
    partition: message.partitionSession.deref()?.partitionId,
    seqNo: message.seqNo,
    writtenAt:
      message.writtenAt === undefined ? undefined : new Date(message.writtenAt),
    raw,
  };
}

/** Stream decoded change batches from a managed changefeed topic. */
export async function* readChangefeed(
  driver: YdbDriver,
  contract: Contract<SqlStorage>,
  modelName: string,
  options: YdbChangefeedOptions,
  shutdown?: AbortSignal,
): AsyncIterable<YdbChangeBatch> {
  const model = resolveModel(contract, modelName);
  const feeds = model.options.changefeeds ?? [];
  const feed =
    options.feed === undefined
      ? feeds.length === 1
        ? feeds[0]
        : undefined
      : feeds.find((entry) => entry.name === options.feed);
  if (!feed)
    throw new TypeError(
      options.feed === undefined
        ? `YDB model ${modelName} must declare exactly one @@changefeed, or pass feed`
        : `YDB model ${modelName} declares no changefeed ${options.feed}`,
    );
  if (feed.format !== 'JSON')
    throw new TypeError(
      `Changefeed ${feed.name} uses ${feed.format}; only Json records are decoded (read other formats with @ydbjs/topic directly)`,
    );
  if (typeof options.consumer !== 'string' || !options.consumer)
    throw new TypeError('Changefeed consumer is required');
  const core = driver.core;
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const signal of [options.signal, shutdown]) {
    if (!signal) continue;
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  const reader = createTopicReader(core, {
    topic: {
      path: `${core.database}/${model.table}/${feed.name}`,
      ...(options.partitionIds
        ? { partitionIds: [...options.partitionIds] }
        : {}),
      ...(options.readFrom ? { readFrom: options.readFrom } : {}),
      ...(options.maxLagMs !== undefined ? { maxLag: options.maxLagMs } : {}),
    },
    consumer: options.consumer,
    ...(options.maxBufferBytes !== undefined
      ? { maxBufferBytes: options.maxBufferBytes }
      : {}),
  });
  try {
    // One read() call ends after `limit` messages; keep reading until aborted.
    while (!controller.signal.aborted) {
      for await (const messages of reader.read({
        limit: options.limit,
        waitMs: options.waitMs,
        signal: controller.signal,
      })) {
        if (!messages.length) continue;
        const events = messages.map((message) => decodeMessage(model, message));
        yield { events, commit: () => reader.commit(messages) };
      }
    }
  } finally {
    for (const signal of [options.signal, shutdown])
      signal?.removeEventListener('abort', abort);
    // Never let reader teardown mask the error that ended the iteration.
    await reader.close().catch(() => reader.destroy());
  }
}
