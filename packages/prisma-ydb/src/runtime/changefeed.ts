import {
  createTopicReader,
  type TopicReaderOptions,
} from '@ydbjs/topic/reader';
import type { TopicMessage } from '@ydbjs/topic/message';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type { JsonValue } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import type { YdbDriver } from '../driver/driver.js';
import { decodeYdbJson } from './codecs.js';
import { resolveModel, type ModelColumn, type ResolvedModel } from './model.js';

/** One topic partition assigned to this reader. */
export interface YdbChangefeedPartition {
  readonly partitionId: bigint;
  /** Identifies this assignment; a reassigned partition gets a new session. */
  readonly partitionSessionId: bigint;
  /** The consumer's committed offset when the event was raised. */
  readonly committedOffset: bigint;
  /** Offsets currently retained in the partition, `end` exclusive. */
  readonly startOffset: bigint;
  readonly endOffset: bigint;
  /** The consumer fell behind the earliest retained offset. */
  readonly retentionExpired: boolean;
}

/** Positions to start an assigned partition from; omitted fields keep the server's. */
export interface YdbChangefeedStartPosition {
  /** Committed offset to set before reading; defaults to the current one. */
  readonly commitOffset?: bigint;
  /** First offset to deliver, not below `commitOffset`; defaults to it. */
  readonly readOffset?: bigint;
}

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
  /**
   * The server assigned a partition to this reader. Return a start position to
   * resume from offsets stored outside the topic; return nothing to resume
   * after the consumer's committed offset. Reading of the partition waits for it.
   */
  readonly onPartitionStart?: (
    partition: YdbChangefeedPartition,
  ) =>
    | void
    | YdbChangefeedStartPosition
    | Promise<void | YdbChangefeedStartPosition>;
  /**
   * The server is taking a partition away (rebalancing, reader shutdown or
   * partition split). Batches of it that were not committed are delivered
   * again to its next reader; committing them afterwards fails.
   */
  readonly onPartitionStop?: (
    partition: YdbChangefeedPartition,
  ) => void | Promise<void>;
  /** The server acknowledged committed offsets for a partition. */
  readonly onCommitted?: (partition: YdbChangefeedPartition) => void;
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
  readonly partitionSessionId: bigint | undefined;
  readonly seqNo: bigint;
  readonly writtenAt: Date | undefined;
  /**
   * The server record. Integers beyond Number.MAX_SAFE_INTEGER are kept as
   * decimal strings so no digit is lost; other numbers are JavaScript numbers.
   */
  readonly raw: JsonValue;
}

export interface YdbChangefeedDecodeError {
  readonly partitionId: bigint;
  readonly partitionSessionId: bigint;
  readonly offset: bigint | undefined;
  readonly error: unknown;
  readonly payload: Uint8Array;
}

export interface YdbChangePartitionBatch<Row = Record<string, unknown>> {
  readonly partitionId: bigint;
  readonly partitionSessionId: bigint;
  readonly events: readonly YdbChangeEvent<Row>[];
  readonly errors: readonly YdbChangefeedDecodeError[];
  /** Acknowledge successfully decoded records before any decode failure. */
  commit(): Promise<void>;
}

export interface YdbChangeBatch<Row = Record<string, unknown>> {
  readonly events: readonly YdbChangeEvent<Row>[];
  readonly partitions: readonly YdbChangePartitionBatch<Row>[];
  /** Acknowledge partitions without decode errors in this batch. */
  commit(): Promise<void>;
}

/**
 * A JSON number kept as its source text. YDB writes Int64/Uint64 values and
 * the `ts` pair as bare JSON numbers, which plain JSON.parse rounds to doubles.
 */
class JsonNumber {
  constructor(readonly text: string) {}
}

type Token =
  | null
  | boolean
  | string
  | number
  | JsonNumber
  | Token[]
  | { [key: string]: Token };

/** Source-text access in JSON.parse revivers (Node 21+, required by engines). */
const losslessJson =
  JSON.parse('1', (_key, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' ? context?.source : value,
  ) === '1';

const textDecoder = new TextDecoder();
const longDigits = /\d{16,}/;
// Source-sensitive fractional/exponent numbers stay on the reviver path.
// Matches inside strings only cause a conservative fallback.
const nonIntegerNumber =
  /(?:^|[[:,])\s*-?\d+(?:\.\d+(?:[eE][+-]?\d+)?|[eE][+-]?\d+)\s*(?=[,}\]]|$)/;

function ordinaryIntegers(text: string): boolean {
  return !longDigits.test(text) && !nonIntegerNumber.test(text);
}

function parseTokens(text: string): Token {
  if (ordinaryIntegers(text)) return JSON.parse(text) as Token;
  if (!losslessJson)
    throw new Error(
      'db.changefeed needs JSON.parse source text access (Node 24+) to decode 64-bit integers exactly',
    );
  return JSON.parse(
    text,
    (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' ? new JsonNumber(context!.source!) : value,
  ) as Token;
}

const integerLiteral = /^-?\d+$/;

/** JSON with every number as a JavaScript number, as ORM reads of Json columns return. */
function plainJson(token: Token): JsonValue {
  if (token instanceof JsonNumber) return Number(token.text);
  if (Array.isArray(token)) return token.map(plainJson);
  if (token && typeof token === 'object')
    return Object.fromEntries(
      Object.entries(token).map(([key, value]) => [key, plainJson(value)]),
    );
  return token;
}

/** JSON for `raw`: unsafe integers stay exact as decimal strings. */
function rawJson(token: Token): JsonValue {
  if (token instanceof JsonNumber) {
    const value = Number(token.text);
    return integerLiteral.test(token.text) && !Number.isSafeInteger(value)
      ? token.text
      : value;
  }
  if (Array.isArray(token)) return token.map(rawJson);
  if (token && typeof token === 'object')
    return Object.fromEntries(
      Object.entries(token).map(([key, value]) => [key, rawJson(value)]),
    );
  return token;
}

/** Codecs whose JSON form is a decimal string rather than a number. */
const textNumberCodecs = new Set([
  'ydb/int64@1',
  'ydb/uint64@1',
  'ydb/number@1',
  'ydb/decimal@1',
]);
/** CDC writes Date values as midnight timestamps. */
const cdcDate = /^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?Z$/;

/** Changefeed JSON is YDB's own encoding; align one scalar with its codec's JSON form. */
function codecJson(codecId: string, token: Token): JsonValue {
  if (token instanceof JsonNumber)
    return textNumberCodecs.has(codecId) ? token.text : Number(token.text);
  if (typeof token === 'number')
    return textNumberCodecs.has(codecId) ? String(token) : token;
  if (codecId === 'ydb/json@1')
    return typeof token === 'string'
      ? (JSON.parse(token) as JsonValue)
      : plainJson(token);
  if (codecId === 'ydb/date@1' && typeof token === 'string')
    return cdcDate.exec(token)?.[1] ?? token;
  if (token !== null && typeof token === 'object')
    throw new TypeError(`Changefeed value for ${codecId} is not a scalar`);
  return token;
}

function decodeField(column: ModelColumn, token: Token): unknown {
  if (token === null) return null;
  if (column.many) {
    // Lists are stored as Json holding the elements' codec JSON forms.
    const list = typeof token === 'string' ? parseTokens(token) : token;
    if (!Array.isArray(list))
      throw new TypeError(
        `Changefeed list column ${column.column} is not an array`,
      );
    return list.map((element) =>
      decodeYdbJson(
        column.codecId,
        codecJson(column.codecId, element),
        column.typeParams,
      ),
    );
  }
  return decodeYdbJson(
    column.codecId,
    codecJson(column.codecId, token),
    column.typeParams,
  );
}

function decodeImage(
  model: ResolvedModel,
  image: Token,
): Record<string, unknown> {
  if (typeof image !== 'object' || image === null || Array.isArray(image))
    throw new TypeError('Changefeed image is not an object');
  const row: Record<string, unknown> = {};
  for (const name in image) {
    if (!Object.hasOwn(image, name)) continue;
    const value = (image as { [key: string]: Token })[name]!;
    const column = model.byColumn.get(name);
    if (column) row[column.field] = decodeField(column, value);
  }
  return row;
}

function decodeKey(
  model: ResolvedModel,
  key: Token | undefined,
): Record<string, unknown> {
  if (!Array.isArray(key) || key.length !== model.primaryKey.length)
    throw new TypeError('Changefeed key does not match the primary key');
  const row: Record<string, unknown> = {};
  model.primaryKey.forEach((column, index) => {
    row[column.field] = decodeField(column, key[index] ?? null);
  });
  return row;
}

function virtualTimestamp(
  ts: Token | undefined,
): readonly [bigint, bigint] | undefined {
  if (
    !Array.isArray(ts) ||
    ts.length !== 2 ||
    !ts.every((part) =>
      typeof part === 'number'
        ? Number.isSafeInteger(part)
        : part instanceof JsonNumber && integerLiteral.test(part.text),
    )
  )
    return undefined;
  return [
    BigInt(typeof ts[0] === 'number' ? ts[0] : (ts[0] as JsonNumber).text),
    BigInt(typeof ts[1] === 'number' ? ts[1] : (ts[1] as JsonNumber).text),
  ];
}

// Share the accessor so event objects keep one shape; cache raw on first access.
const rawTokens = Symbol('changefeed tokens');
const rawDescriptor: PropertyDescriptor = {
  enumerable: true,
  configurable: true,
  get(this: { [rawTokens]: Token }): JsonValue {
    const value = rawJson(this[rawTokens]);
    Object.defineProperty(this, 'raw', {
      value,
      enumerable: true,
      configurable: true,
    });
    return value;
  },
};

function decodeMessage(
  model: ResolvedModel,
  message: TopicMessage,
): YdbChangeEvent {
  const tokens = parseTokens(textDecoder.decode(message.payload));
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens))
    throw new TypeError('Changefeed record is not an object');
  const record = tokens as Record<string, Token>;
  const key = decodeKey(model, record['key']);
  // Images carry non-key columns only; merge the key so they read as full rows.
  const image = (name: string) => {
    const value = record[name];
    return value === undefined || value === null
      ? undefined
      : { ...key, ...decodeImage(model, value) };
  };
  const newImage = image('newImage');
  const oldImage = image('oldImage');
  const updates = record['update'];
  const ts = virtualTimestamp(record['ts']);
  const session = message.partitionSession.deref();
  const event = {
    kind: 'erase' in record ? 'erase' : 'update',
    key,
    ...(updates !== undefined && updates !== null
      ? { updates: decodeImage(model, updates) }
      : {}),
    ...(newImage ? { newImage } : {}),
    ...(oldImage ? { oldImage } : {}),
    ...(ts ? { ts } : {}),
    offset: message.offset,
    partition: session?.partitionId,
    partitionSessionId: session?.partitionSessionId,
    seqNo: message.seqNo,
    writtenAt:
      message.writtenAt === undefined ? undefined : new Date(message.writtenAt),
  };
  Object.defineProperty(event, rawTokens, { value: tokens });
  return Object.defineProperty(event, 'raw', rawDescriptor) as YdbChangeEvent;
}

type TopicPartitionSession = Parameters<
  NonNullable<TopicReaderOptions['onPartitionSessionStop']>
>[0];

function partitionOf(
  session: TopicPartitionSession,
  committedOffset: bigint,
): YdbChangefeedPartition {
  return {
    partitionId: session.partitionId,
    partitionSessionId: session.partitionSessionId,
    committedOffset,
    startOffset: session.partitionOffsets?.start ?? 0n,
    endOffset: session.partitionOffsets?.end ?? 0n,
    retentionExpired: committedOffset < (session.partitionOffsets?.start ?? 0n),
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
  // The SDK swallows hook exceptions; end the iteration with them instead.
  let hookFailure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    hookFailure ??= { error };
    controller.abort(error);
  };
  const { onPartitionStart, onPartitionStop, onCommitted } = options;
  // The SDK has no reader API to pause one partition. Drain quarantined
  // messages without decoding or committing them; reassignment replays them.
  const quarantined = new Map<bigint, bigint | undefined>();
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
    async onPartitionSessionStart(session, committedOffset, offsets) {
      quarantined.delete(session.partitionSessionId);
      try {
        const position = await onPartitionStart?.({
          partitionId: session.partitionId,
          partitionSessionId: session.partitionSessionId,
          committedOffset,
          startOffset: offsets.start,
          endOffset: offsets.end,
          retentionExpired: committedOffset < offsets.start,
        });
        if (!position) return undefined;
        // The SDK sends 0 for an omitted field, which would reset the
        // consumer; fill both from the server's current positions.
        const commitOffset = position.commitOffset ?? committedOffset;
        session.nextCommitStartOffset = commitOffset;
        return {
          readOffset: position.readOffset ?? commitOffset,
          commitOffset,
        };
      } catch (error) {
        fail(error);
        return undefined;
      }
    },
    async onPartitionSessionStop(session, committedOffset) {
      quarantined.delete(session.partitionSessionId);
      try {
        await onPartitionStop?.(partitionOf(session, committedOffset));
      } catch (error) {
        fail(error);
      }
    },
    ...(onCommitted
      ? {
          onCommittedOffset(session, committedOffset) {
            try {
              onCommitted(partitionOf(session, committedOffset));
            } catch (error) {
              fail(error);
            }
          },
        }
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
        const events: YdbChangeEvent[] = [];
        const groups = new Map<
          bigint,
          {
            partitionId: bigint;
            partitionSessionId: bigint;
            events: YdbChangeEvent[];
            errors: YdbChangefeedDecodeError[];
            messages: TopicMessage[];
          }
        >();
        for (const message of messages) {
          const session = message.partitionSession.deref();
          if (
            !session ||
            session.isStopped ||
            quarantined.has(session.partitionSessionId)
          )
            continue;
          let group = groups.get(session.partitionSessionId);
          if (!group) {
            group = {
              partitionId: session.partitionId,
              partitionSessionId: session.partitionSessionId,
              events: [],
              errors: [],
              messages: [],
            };
            groups.set(session.partitionSessionId, group);
          }
          try {
            const event = decodeMessage(model, message);
            events.push(event);
            group.events.push(event);
            group.messages.push(message);
          } catch (error) {
            quarantined.set(session.partitionSessionId, message.offset);
            group.errors.push({
              partitionId: session.partitionId,
              partitionSessionId: session.partitionSessionId,
              offset: message.offset,
              error,
              payload: message.payload,
            });
          }
        }
        if (!groups.size) continue;
        const partitions = [...groups.values()].map((group) => {
          let committed: Promise<void> | undefined;
          return {
            partitionId: group.partitionId,
            partitionSessionId: group.partitionSessionId,
            events: group.events,
            errors: group.errors,
            commit: () =>
              (committed ??= (async () => {
                const badOffset = quarantined.get(group.partitionSessionId);
                const safe = quarantined.has(group.partitionSessionId)
                  ? group.messages.filter(
                      (message) =>
                        badOffset !== undefined &&
                        message.offset !== undefined &&
                        message.offset < badOffset,
                    )
                  : group.messages;
                if (!safe.length) return;
                try {
                  await reader.commit(safe);
                } catch (reason) {
                  throw reason instanceof Error
                    ? reason
                    : new Error(
                        `YDB changefeed commit failed: ${String(reason)}`,
                      );
                }
              })()),
          };
        });
        yield {
          events,
          partitions,
          commit: async () => {
            // Commit separately: the SDK's multi-partition promise resolves
            // after the first partition acknowledgement, rather than all of them.
            await Promise.all(
              partitions
                .filter((part) => !part.errors.length)
                .map((part) => part.commit()),
            );
          },
        };
      }
    }
    if (hookFailure) throw hookFailure.error;
  } finally {
    for (const signal of [options.signal, shutdown])
      signal?.removeEventListener('abort', abort);
    // Never let reader teardown mask the error that ended the iteration.
    await reader.close().catch(() => reader.destroy());
  }
}
