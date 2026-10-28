import {
  createTopicReader,
  type TopicReaderOptions,
} from '@ydbjs/topic/reader';
import type { TopicMessage } from '@ydbjs/topic/message';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type { JsonValue } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import type { YdbDriver } from '../driver/driver.js';
import { nativeCodecConversions } from './codecs.js';
import { resolveModel, type ModelColumn, type ResolvedModel } from './model.js';

/** Local controls for one partition assignment. */
export interface YdbChangefeedPartitionControl {
  readonly stopped: boolean;
  readonly paused: boolean;
  readonly stopReason: unknown;
  /** Quarantine this assignment permanently, without committing it. */
  stop(reason?: unknown): void;
  /** Buffer further delivery until resumed. */
  pause(): void;
  resume(): void;
}

/** One topic partition assigned to this reader. */
export interface YdbChangefeedPartition extends YdbChangefeedPartitionControl {
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
  /** Decode only these model fields plus the full primary key. */
  readonly fields?: readonly string[];
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

export interface YdbChangePartitionBatch<
  Row = Record<string, unknown>,
> extends YdbChangefeedPartitionControl {
  readonly partitionId: bigint;
  readonly partitionSessionId: bigint;
  readonly events: readonly YdbChangeEvent<Row>[];
  readonly errors: readonly YdbChangefeedDecodeError[];
  /** Acknowledge successfully decoded records before any decode failure. */
  commit(): Promise<void>;
  /** Commit through this event, including all earlier offsets in this partition. */
  commitThrough(event: YdbChangeEvent<Row>): Promise<void>;
  /** Deliberately acknowledge a decoded poison event and its preceding offsets. */
  skip(event: YdbChangeEvent<Row>): Promise<void>;
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

function compileField(column: ModelColumn): (token: Token) => unknown {
  const decode = nativeCodecConversions(
    column.codecId,
    column.typeParams,
  ).decodeJson;
  const scalar = (token: Token) => decode(codecJson(column.codecId, token));
  return (token) => {
    if (token === null) return null;
    if (!column.many) return scalar(token);
    // Lists are stored as Json holding the elements' codec JSON forms.
    const list = typeof token === 'string' ? parseTokens(token) : token;
    if (!Array.isArray(list))
      throw new TypeError(
        `Changefeed list column ${column.column} is not an array`,
      );
    return list.map(scalar);
  };
}

/** Resolve projection and codec dispatch once per reader, outside the record loop. */
function compileDecoder(model: ResolvedModel, fields?: readonly string[]) {
  const selected =
    fields === undefined
      ? model.columns
      : fields.map((field) => {
          const column = model.byField.get(field);
          if (!column)
            throw new TypeError(
              `Unknown changefeed field ${model.name}.${field}`,
            );
          return column;
        });
  const columns = [...new Set([...model.primaryKey, ...selected])].map(
    (column) => ({
      ...column,
      decode: compileField(column),
    }),
  );
  const byColumn = new Map(columns.map((column) => [column.column, column]));
  const keys = model.primaryKey.map((column) => byColumn.get(column.column)!);
  return {
    image(image: Token): Record<string, unknown> {
      if (typeof image !== 'object' || image === null || Array.isArray(image))
        throw new TypeError('Changefeed image is not an object');
      const row: Record<string, unknown> = {};
      for (const column of columns) {
        if (Object.hasOwn(image, column.column))
          row[column.field] = column.decode(
            (image as Record<string, Token>)[column.column]!,
          );
      }
      return row;
    },
    key(key: Token | undefined): Record<string, unknown> {
      if (!Array.isArray(key) || key.length !== keys.length)
        throw new TypeError('Changefeed key does not match the primary key');
      const row: Record<string, unknown> = {};
      for (let index = 0; index < keys.length; index++) {
        const column = keys[index]!;
        row[column.field] = column.decode(key[index] ?? null);
      }
      return row;
    },
  };
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
  decoder: ReturnType<typeof compileDecoder>,
  message: TopicMessage,
): YdbChangeEvent {
  const tokens = parseTokens(textDecoder.decode(message.payload));
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens))
    throw new TypeError('Changefeed record is not an object');
  const record = tokens as Record<string, Token>;
  const key = decoder.key(record['key']);
  // Images carry non-key columns only; merge the key so they read as full rows.
  const image = (name: string) => {
    const value = record[name];
    return value === undefined || value === null
      ? undefined
      : { ...key, ...decoder.image(value) };
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
      ? { updates: decoder.image(updates) }
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
  control: YdbChangefeedPartitionControl,
): YdbChangefeedPartition {
  return Object.assign(
    Object.create(control) as YdbChangefeedPartitionControl,
    {
      partitionId: session.partitionId,
      partitionSessionId: session.partitionSessionId,
      committedOffset,
      startOffset: session.partitionOffsets?.start ?? 0n,
      endOffset: session.partitionOffsets?.end ?? 0n,
      retentionExpired:
        committedOffset < (session.partitionOffsets?.start ?? 0n),
    },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  const decoder = compileDecoder(model, options.fields);
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
  const controls = new Map<bigint, YdbChangefeedPartitionControl>();
  const pending = new Map<bigint, TopicMessage[]>();
  let pendingBytes = 0n;
  const pendingBudget = options.maxBufferBytes ?? 16n * 1024n * 1024n;
  let wake = deferred();
  const notify = () => {
    wake.resolve();
  };
  const clearPending = (id: bigint) => {
    for (const message of pending.get(id) ?? [])
      pendingBytes -= BigInt(message.payload.byteLength);
    pending.delete(id);
  };
  const controlFor = (session: TopicPartitionSession) => {
    let control = controls.get(session.partitionSessionId);
    if (!control) {
      let stopped = false;
      let paused = false;
      let reason: unknown;
      control = {
        get stopped() {
          return stopped || session.isStopped;
        },
        get paused() {
          return paused;
        },
        get stopReason() {
          return reason;
        },
        stop(value) {
          if (stopped) return;
          stopped = true;
          reason = value;
          paused = false;
          clearPending(session.partitionSessionId);
          notify();
        },
        pause() {
          if (!stopped) paused = true;
        },
        resume() {
          paused = false;
          notify();
        },
      };
      controls.set(session.partitionSessionId, control);
    }
    return control;
  };
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
    async onPartitionSessionStart(session, committedOffset) {
      quarantined.delete(session.partitionSessionId);
      try {
        const control = controlFor(session);
        const position = await onPartitionStart?.(
          partitionOf(session, committedOffset, control),
        );
        if (control.stopped) return undefined;
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
      const control = controlFor(session);
      control.stop();
      controls.delete(session.partitionSessionId);
      try {
        await onPartitionStop?.(partitionOf(session, committedOffset, control));
      } catch (error) {
        fail(error);
      }
    },
    ...(onCommitted
      ? {
          onCommittedOffset(session, committedOffset) {
            try {
              onCommitted(
                partitionOf(session, committedOffset, controlFor(session)),
              );
            } catch (error) {
              fail(error);
            }
          },
        }
      : {}),
  });
  let source: AsyncIterator<TopicMessage[]> | undefined;
  let next: Promise<IteratorResult<TopicMessage[]>> | undefined;
  try {
    while (!controller.signal.aborted) {
      const messages: TopicMessage[] = [];
      for (const [id, buffered] of pending) {
        const control = controls.get(id);
        if (!control || control.stopped) clearPending(id);
        else if (!control.paused) {
          messages.push(...buffered);
          clearPending(id);
        }
      }
      if (!messages.length) {
        if (pendingBytes >= pendingBudget) {
          const abortWake = () => notify();
          controller.signal.addEventListener('abort', abortWake, {
            once: true,
          });
          try {
            await wake.promise;
          } finally {
            controller.signal.removeEventListener('abort', abortWake);
            wake = deferred();
          }
          continue;
        }
        source ??= reader
          .read({
            limit: options.limit,
            waitMs: options.waitMs,
            signal: controller.signal,
          })
          [Symbol.asyncIterator]();
        next ??= source.next();
        const result = await Promise.race([
          next.then((value) => ({ value })),
          wake.promise.then(() => undefined),
        ]);
        wake = deferred();
        if (!result) continue;
        next = undefined;
        if (result.value.done) {
          source = undefined;
          continue;
        }
        messages.push(...result.value.value);
      }
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
          controlFor(session).stopped ||
          quarantined.has(session.partitionSessionId)
        )
          continue;
        if (controlFor(session).paused) {
          let buffered = pending.get(session.partitionSessionId);
          if (!buffered)
            pending.set(session.partitionSessionId, (buffered = []));
          buffered.push(message);
          pendingBytes += BigInt(message.payload.byteLength);
          continue;
        }
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
          const event = decodeMessage(decoder, message);
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
        const session = group.messages[0]?.partitionSession.deref();
        const control = controls.get(group.partitionSessionId)!;
        let committed: Promise<void> | undefined;
        let commitTail = Promise.resolve();
        const commitMessages = (messages: TopicMessage[]) => {
          const operation = commitTail.then(async () => {
            if (!messages.length) return;
            if (!session || session.isStopped)
              throw new Error('Changefeed partition session stopped');
            if (control.stopped)
              throw new Error(
                `Changefeed partition stopped: ${String(control.stopReason)}`,
              );
            const last = messages[messages.length - 1]!;
            if (last.offset === undefined)
              throw new Error('Cannot commit event without offset');
            if (last.offset < session.nextCommitStartOffset) return;
            try {
              await reader.commit(last);
            } catch (reason) {
              throw reason instanceof Error
                ? reason
                : new Error(`YDB changefeed commit failed: ${String(reason)}`);
            }
          });
          commitTail = operation.catch(() => {});
          return operation;
        };
        const stoppedCommit = () =>
          Promise.reject(
            new Error(
              `Changefeed partition stopped: ${String(control.stopReason)}`,
            ),
          );
        const commitThrough = (event: YdbChangeEvent) => {
          if (control.stopped) return stoppedCommit();
          const index = group.events.indexOf(event);
          if (index < 0)
            return Promise.reject(
              new TypeError('Event does not belong to this partition batch'),
            );
          return commitMessages(group.messages.slice(0, index + 1));
        };
        return Object.assign(
          Object.create(control) as YdbChangefeedPartitionControl,
          {
            partitionId: group.partitionId,
            partitionSessionId: group.partitionSessionId,
            events: group.events,
            errors: group.errors,
            commitThrough,
            skip: commitThrough,
            commit: () =>
              control.stopped
                ? stoppedCommit()
                : (committed ??= (() => {
                    const badOffset = quarantined.get(group.partitionSessionId);
                    const safe = quarantined.has(group.partitionSessionId)
                      ? group.messages.filter(
                          (message) =>
                            badOffset !== undefined &&
                            message.offset !== undefined &&
                            message.offset < badOffset,
                        )
                      : group.messages;
                    return commitMessages(safe);
                  })()),
          },
        );
      });
      yield {
        events,
        partitions,
        commit: async () => {
          // Commit separately: the SDK's multi-partition promise resolves
          // after the first partition acknowledgement, rather than all of them.
          await Promise.all(
            partitions
              .filter((part) => !part.stopped && !part.errors.length)
              .map((part) => part.commit()),
          );
        },
      };
    }
    if (hookFailure) throw hookFailure.error;
  } finally {
    controller.abort();
    for (const signal of [options.signal, shutdown])
      signal?.removeEventListener('abort', abort);
    for (const control of controls.values()) control.stop();
    controls.clear();
    pending.clear();
    // Release SDK generator abort listeners, including when the consumer breaks.
    await source?.return?.().catch(() => {});
    // Never let reader teardown mask the error that ended the iteration.
    await reader.close().catch(() => reader.destroy());
  }
}
