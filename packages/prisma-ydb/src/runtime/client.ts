import {
  buildNamespacedEnums,
  type NamespacedEnums,
} from '@prisma/orm-framework/contract/enum-accessor';
import type { Contract } from '@prisma/orm-framework/contract/types';
import {
  createRawLane,
  sql as sqlBuilder,
} from '@prisma/orm-family-sql/builder/runtime';
import type { Db, RawLane } from '@prisma/orm-family-sql/builder/types';
import type {
  ExtractCodecTypes,
  SqlStorage,
} from '@prisma/orm-family-sql/contract/types';
import {
  orm as ormBuilder,
  prepareQuery,
  type PreparedFrom,
} from '@prisma/orm-family-sql/orm-client';
import type { CodecTypesBase } from '@prisma/orm-family-sql/relational-core/expression';
import type {
  Preparable,
  SqlQueryPlan,
} from '@prisma/orm-family-sql/relational-core/plan';
import type {
  MarkerReadResult,
  SqlDriver,
  SqlExecuteRequest,
} from '@prisma/orm-family-sql/relational-core/ast';
import {
  createExecutionContext,
  createSqlExecutionStack,
  SqlRuntimeBase,
  validateCodecRegistryCompleteness,
  type BindSiteParams,
  type Declaration,
  type ExecutionContext,
  type ParamsFromDeclaration,
  type Runtime,
  type RuntimeQueryable,
  type SqlMiddleware,
  type SqlRuntimeExtensionDescriptor,
  type VerifyMarkerOption,
} from '@prisma/orm-family-sql/runtime';
import { SqlConnectionError } from '@prisma/orm-family-sql/errors';
import {
  preparedStatementExecute,
  preparedStatementQuery,
} from '@prisma/orm-family-sql/runtime/internal/prepared-query';
import { sleep } from '../driver/abort.js';
import {
  YdbDriver,
  isRetryableYdbError,
  retryDefaults,
  retryDelayMs,
  type YdbPoolStats,
  type YdbHealth,
  type YdbBinding,
  type YdbDriverOptions,
  type YdbParameter,
  type YdbQueryRequest,
  type YdbQueryResult,
  type YdbTransactionMode,
} from '../driver/index.js';
import { ydbContractSerializer } from '../control/contract.js';
import {
  bulkUpsertModel,
  type YdbBulkUpsertOptions,
  type YdbBulkUpsertResult,
} from './bulk.js';
import {
  readChangefeed,
  type YdbChangeBatch,
  type YdbChangefeedOptions,
} from './changefeed.js';
import { YdbJsonElement } from './codecs.js';
import {
  createYdbRuntimeAdapter,
  readYdbRuntimeMarker,
  ydbRawCodecInferer,
  ydbRuntimeAdapter,
  ydbRuntimeDriver,
  ydbRuntimeTarget,
} from './descriptors.js';

type GenericOrm<C extends Contract<SqlStorage>> = ReturnType<
  typeof ormBuilder<C>
>;
type YdbOrm<C extends Contract<SqlStorage>> = GenericOrm<C> &
  GenericOrm<C>[keyof C['domain']['namespaces'] & keyof GenericOrm<C>];
/** Flat enum access for YDB's sole namespace, retaining namespaced access. */
export type YdbEnums<C extends Contract<SqlStorage>> = NamespacedEnums<C> &
  Omit<
    NamespacedEnums<C>[keyof C['domain']['namespaces']],
    keyof NamespacedEnums<C>
  >;
export interface YdbOptions<C extends Contract<SqlStorage>> {
  readonly contractJson?: unknown;
  readonly contract?: C;
  readonly url?: string;
  readonly binding?: YdbBinding;
  readonly driverOptions?: YdbDriverOptions;
  readonly verifyMarker?: VerifyMarkerOption;
  readonly middleware?: readonly SqlMiddleware[];
  readonly extensions?: readonly SqlRuntimeExtensionDescriptor<'ydb'>[];
}
export interface YdbQueryMembers<
  C extends Contract<SqlStorage>,
> extends RuntimeQueryable {
  readonly orm: YdbOrm<C>;
  readonly sql: Db<C>;
  readonly raw: RawLane<C>;
  readonly enums: YdbEnums<C>;
  /** Native YQL; Timestamp columns remain bigint microseconds so no precision is lost. */
  yql(
    text: string,
    parameters?: Readonly<Record<string, YdbParameter>>,
  ): Promise<Record<string, unknown>[]>;
  /** Native result sets, column descriptors, statistics and cancellation options. */
  queryYql(request: YdbQueryRequest): Promise<YdbQueryResult>;
}
export interface YdbTransactionContext<
  C extends Contract<SqlStorage>,
> extends YdbQueryMembers<C> {
  readonly invalidated: boolean;
  readonly signal: AbortSignal;
}
export interface YdbTransactionOptions {
  readonly retry?: boolean | { readonly maxAttempts?: number };
  /**
   * `snapshotReadOnly` reads one consistent snapshot without conflicting with
   * writers; the server rejects writes inside it. Default: `serializable`.
   */
  readonly mode?: YdbTransactionMode;
}
/** Rows of one model keyed by field name; list fields take arrays. */
export type YdbModelRows = readonly Readonly<Record<string, unknown>>[];

export interface YdbClient<C extends Contract<SqlStorage>>
  extends YdbQueryMembers<C>, YdbClientLifecycle<C> {}
interface YdbClientLifecycle<C extends Contract<SqlStorage>> {
  readonly contract: C;
  readonly context: ExecutionContext<C>;
  /**
   * The same ORM/SQL/raw lanes streaming rows as the server sends them, without
   * the buffered result bounds. Abandoning an iterator early cancels the RPC
   * and discards its session, so prefer it for full scans you consume entirely.
   */
  readonly streaming: YdbQueryMembers<C>;
  connect(binding?: YdbBinding): Promise<Runtime>;
  runtime(): Runtime;
  /**
   * TableService BulkUpsert of encoded model rows: idempotent, chunked and
   * outside any transaction. Bypasses temporal presets and referential actions.
   */
  bulkUpsert(
    model: keyof C['domain']['namespaces'][keyof C['domain']['namespaces']]['models'] &
      string,
    rows: YdbModelRows,
    options?: YdbBulkUpsertOptions,
  ): Promise<YdbBulkUpsertResult>;
  /** Decoded change batches from a managed `@@changefeed` topic. */
  changefeed(
    model: keyof C['domain']['namespaces'][keyof C['domain']['namespaces']]['models'] &
      string,
    options: YdbChangefeedOptions,
  ): AsyncIterable<YdbChangeBatch>;
  transaction<T>(
    callback: (tx: YdbTransactionContext<C>) => PromiseLike<T>,
    options?: YdbTransactionOptions,
  ): Promise<T>;
  stats(): YdbPoolStats;
  health(options?: {
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<YdbHealth>;
  prepare<
    D extends Declaration<CT>,
    Q extends SqlQueryPlan | Preparable<unknown, unknown>,
    CT extends CodecTypesBase = ExtractCodecTypes<C>,
  >(
    declaration: D,
    callback: (params: BindSiteParams<D>) => Q,
  ): Promise<PreparedFrom<ParamsFromDeclaration<D, CT>, Q>>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

function linkSignals(parent: AbortSignal, caller?: AbortSignal) {
  const controller = new AbortController();
  const signals = caller && caller !== parent ? [parent, caller] : [parent];
  const listeners = signals.map((signal) => {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    return { signal, abort };
  });
  return {
    signal: controller.signal,
    dispose() {
      for (const { signal, abort } of listeners)
        signal.removeEventListener('abort', abort);
    },
  };
}

class YdbRuntime<C extends Contract<SqlStorage>> extends SqlRuntimeBase<C> {
  protected override getListDecoder() {
    return async (
      wire: unknown,
      decode: (value: unknown) => Promise<unknown>,
    ) => {
      if (!Array.isArray(wire))
        throw new TypeError('YDB list columns require JSON arrays');
      return Promise.all(
        wire.map((value) => {
          if (value === null)
            throw new TypeError('YDB list elements cannot be null');
          return decode(new YdbJsonElement(value));
        }),
      );
    };
  }
}

/**
 * Prepared handles execute through these symbol methods of the pinned SQL
 * runtime; they are internal Prisma API, re-exported by name rather than
 * discovered by scanning the prototype.
 */
const preparedBridges = [preparedStatementQuery, preparedStatementExecute];

/**
 * The pinned Prisma RC has no public API for two things this client relies on:
 * the prepared-statement bridge and the per-runtime codec-validation flag that
 * lets transaction runtimes skip repeating the contract check. Fail at client
 * construction, not under load, if an upgrade moved either of them.
 */
function assertPinnedRuntimeShape(runtime: object): void {
  for (const key of preparedBridges)
    if (typeof Reflect.get(runtime, key) !== 'function')
      throw new Error(
        `prisma-ydb: the pinned Prisma runtime no longer exposes ${key.description}; upgrade prisma-ydb together with @prisma/orm-family-sql`,
      );
  if (typeof Reflect.get(runtime, 'codecRegistryValidated') !== 'boolean')
    throw new Error(
      'prisma-ydb: the pinned Prisma runtime no longer exposes codecRegistryValidated; upgrade prisma-ydb together with @prisma/orm-family-sql',
    );
}

/** The contract was validated once by the root runtime; transaction runtimes share that result. */
function markCodecsValidated(runtime: object): void {
  Reflect.set(runtime, 'codecRegistryValidated', true);
}

const transactionPrimaryFailures = new WeakMap<Error, unknown>();

function transactionFailure(
  primary: unknown,
  secondary: unknown,
  message: string,
) {
  const error = new AggregateError([primary, secondary], message);
  transactionPrimaryFailures.set(error, primary);
  return error;
}

function primaryTransactionFailure(error: unknown): unknown {
  while (error instanceof Error && transactionPrimaryFailures.has(error))
    error = transactionPrimaryFailures.get(error);
  return error;
}

/** A lazy native YDB client using Prisma 8's SQL-family ORM, middleware and codecs. */
export function ydb<C extends Contract<SqlStorage>>(
  options: YdbOptions<C>,
): YdbClient<C> {
  if ((options.contract === undefined) === (options.contractJson === undefined))
    throw new TypeError('Provide exactly one of contract or contractJson');
  if (options.url !== undefined && options.binding !== undefined)
    throw new TypeError('Provide either url or binding, not both');
  const contractJson =
    options.contract !== undefined
      ? ydbContractSerializer.serializeContract(options.contract)
      : options.contractJson;
  const contract = ydbContractSerializer.deserializeContract(contractJson) as C;
  const stack = createSqlExecutionStack({
    target: ydbRuntimeTarget,
    adapter: ydbRuntimeAdapter,
    driver: ydbRuntimeDriver,
    extensions: options.extensions ?? [],
  });
  const context = createExecutionContext<C, 'ydb'>({
    contract,
    stack,
    driver: ydbRuntimeDriver,
  });
  const nativeDriver = new YdbDriver(options.driverOptions);
  let binding =
    options.binding ?? (options.url ? { url: options.url } : undefined);
  let connection: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let closeDeadline: number | undefined;
  let closed = false;
  let markerRead: Promise<MarkerReadResult> | undefined;
  let markerReported = false;
  let codecRegistryValidated = false;
  /** Aborted by close(); interrupts retry pauses that hold no session. */
  const shutdown = new AbortController();

  const ensureConnected = async (allowClosing = false) => {
    if (closed && !allowClosing) throw new Error('YDB client is closed');
    if (!binding)
      throw new Error(
        'YDB connection missing: pass binding: { url } or call connect({ url })',
      );
    connection ??= nativeDriver.connect(binding).catch((error) => {
      connection = undefined;
      throw error;
    });
    await connection;
  };
  const driver: SqlDriver<unknown> = {
    connect: () => ensureConnected(),
    async *query<Row>(request: SqlExecuteRequest) {
      await ensureConnected(true);
      yield* nativeDriver.query<Row>(request);
    },
    async execute(request) {
      await ensureConnected(true);
      return nativeDriver.execute(request);
    },
    async acquireConnection() {
      await ensureConnected(true);
      return nativeDriver.acquireConnection();
    },
    close: () => nativeDriver.close(remainingCloseMs()),
  };
  const readMarker = () => {
    markerRead ??= (async () => {
      await ensureConnected(true);
      return readYdbRuntimeMarker(nativeDriver);
    })().catch((error) => {
      markerRead = undefined;
      throw error;
    });
    return markerRead;
  };
  const warmMarker = async () => {
    if (options.verifyMarker !== false) await readMarker();
  };
  const adapter = createYdbRuntimeAdapter({
    readMarker: async () => {
      const result = await readMarker();
      markerReported = true;
      return result;
    },
  });
  const makeRuntime = (
    boundDriver: SqlDriver<unknown>,
    verifyMarker = markerReported ? false : options.verifyMarker,
  ) =>
    new YdbRuntime({
      context,
      adapter,
      driver: boundDriver,
      verifyMarker,
      middleware: options.middleware,
      closeRefusal: 'at-once',
    });
  const runtime = makeRuntime(driver);
  assertPinnedRuntimeShape(runtime);
  const members = (
    boundRuntime: Runtime,
    native: { executeYql(request: YdbQueryRequest): Promise<YdbQueryResult> },
    checkActive: () => void = () => undefined,
    failMutationScope?: () => void,
  ): YdbQueryMembers<C> => {
    let sql: Db<C> | undefined;
    let raw: RawLane<C> | undefined;
    let orm: YdbOrm<C> | undefined;
    let enums: YdbEnums<C> | undefined;
    const scoped: RuntimeQueryable = {
      query(plan, executionOptions) {
        checkActive();
        return boundRuntime.query(plan, executionOptions);
      },
      execute(plan, executionOptions) {
        checkActive();
        return boundRuntime.execute(plan, executionOptions);
      },
    };
    const createOrm = () => {
      const genericOrm = ormBuilder<C>({
        context,
        runtime: {
          ...scoped,
          // Root and streaming lanes own their connections; a transaction lane joins its held one.
          ...(failMutationScope
            ? {}
            : {
                connection: async () => {
                  await warmMarker();
                  return boundRuntime.connection();
                },
              }),
          ...(failMutationScope
            ? {
                transaction: async () => {
                  checkActive();
                  // A nested mutation graph joins the held transaction. YDB has no
                  // savepoints, so graph failure invalidates the whole transaction.
                  return {
                    ...scoped,
                    commit: async () => {
                      checkActive();
                    },
                    rollback: async () => {
                      failMutationScope();
                    },
                  };
                },
              }
            : {}),
        },
      });
      const namespace = Object.keys(contract.domain.namespaces)[0];
      if (!namespace || Object.keys(contract.domain.namespaces).length !== 1)
        throw new Error('YDB expects one domain namespace');
      return new Proxy(genericOrm, {
        get(target, key) {
          const member: unknown = Reflect.get(target, key);
          if (member !== undefined) return member;
          const facet: object = Reflect.get(target, namespace);
          return Reflect.get(facet, key);
        },
      }) as YdbOrm<C>;
    };
    const createEnums = (): YdbEnums<C> => {
      const namespaced = buildNamespacedEnums<C>(contract.domain, (codecId) =>
        context.contractCodecs.forCodecRef({ codecId }),
      );
      const namespaces = Object.keys(contract.domain.namespaces);
      const namespace = namespaces[0];
      if (!namespace || namespaces.length !== 1)
        throw new Error('YDB expects one domain namespace');
      const facet: object = Reflect.get(namespaced, namespace);
      for (const name of Object.keys(facet)) {
        if (Object.hasOwn(namespaced, name)) continue;
        Object.defineProperty(namespaced, name, {
          enumerable: true,
          get: () => Reflect.get(facet, name),
        });
      }
      return namespaced as YdbEnums<C>;
    };
    const queryYql = async (request: YdbQueryRequest) => {
      checkActive();
      if (boundRuntime === runtime) await ensureConnected();
      return native.executeYql({ transactionMode: 'serializable', ...request });
    };
    const result: YdbQueryMembers<C> = {
      ...scoped,
      get orm() {
        return (orm ??= createOrm());
      },
      get sql() {
        return (sql ??= sqlBuilder<C>({
          context,
          rawCodecInferer: ydbRawCodecInferer,
        }));
      },
      get raw() {
        return (raw ??= createRawLane<C>({
          context,
          rawCodecInferer: ydbRawCodecInferer,
        }));
      },
      get enums() {
        return (enums ??= createEnums());
      },
      queryYql,
      async yql(text, parameters) {
        const result = await queryYql({ text, parameters });
        return result.resultSets.flatMap((set) => set.rows);
      },
    };
    for (const key of preparedBridges) {
      const bridge = Reflect.get(boundRuntime, key) as (
        ...args: unknown[]
      ) => unknown;
      Object.defineProperty(result, key, {
        value: (...args: unknown[]) => {
          checkActive();
          return Reflect.apply(bridge, boundRuntime, args);
        },
      });
    }
    return result;
  };
  const checkClosed = () => {
    if (closed) throw new Error('YDB client is closed');
  };
  const rootMembers = members(runtime, nativeDriver, checkClosed);
  let streaming: YdbQueryMembers<C> | undefined;
  const createStreaming = () => {
    const streamingDriver: SqlDriver<unknown> = {
      ...driver,
      async *query<Row>(request: SqlExecuteRequest) {
        await ensureConnected(true);
        yield* nativeDriver.stream<Row>(request);
      },
      close: async () => undefined,
    };
    return members(makeRuntime(streamingDriver), nativeDriver, checkClosed);
  };
  const lifecycle: YdbClientLifecycle<C> = {
    contract,
    context,
    async connect(nextBinding) {
      if (nextBinding) {
        if (connection) throw new Error('YDB client already connected');
        binding = nextBinding;
      }
      await ensureConnected();
      return runtime;
    },
    runtime() {
      if (closed) throw new Error('YDB client is closed');
      return runtime;
    },
    get streaming() {
      return (streaming ??= createStreaming());
    },
    async bulkUpsert(model, rows, bulkOptions) {
      checkClosed();
      await ensureConnected();
      return bulkUpsertModel(nativeDriver, contract, model, rows, bulkOptions);
    },
    async *changefeed(model, feedOptions) {
      checkClosed();
      await ensureConnected();
      yield* readChangefeed(
        nativeDriver,
        contract,
        model,
        feedOptions,
        shutdown.signal,
      );
    },
    prepare<
      D extends Declaration<CT>,
      Q extends SqlQueryPlan | Preparable<unknown, unknown>,
      CT extends CodecTypesBase = ExtractCodecTypes<C>,
    >(
      declaration: D,
      callback: (params: BindSiteParams<D>) => Q,
    ): Promise<PreparedFrom<ParamsFromDeclaration<D, CT>, Q>> {
      if (closed) throw new Error('YDB client is closed');
      return prepareQuery<D, Q, CT>(runtime, declaration, callback);
    },
    stats: () => nativeDriver.stats,
    async health(healthOptions) {
      const closingHealth = (): YdbHealth => ({
        ready: false,
        state: nativeDriver.state === 'closed' ? 'closed' : 'closing',
        pool: nativeDriver.stats,
      });
      if (closed) return closingHealth();
      const result = await nativeDriver.health(healthOptions);
      // close() may start while the readiness RPC is in flight.
      return closed ? closingHealth() : result;
    },
    transaction: runRetriedTransaction as YdbClientLifecycle<C>['transaction'],
    close() {
      if (!closing) {
        closed = true;
        shutdown.abort(new Error('YDB client is closed'));
        closeDeadline = performance.now() + nativeDriver.config.closeTimeoutMs;
        closing = (async () => {
          const drain = (async () => {
            await connection?.catch(() => undefined);
            await runtime.close();
          })();
          const timeoutError = new SqlConnectionError(
            'YDB client close timed out waiting for in-flight operations',
          );
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              drain,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(timeoutError),
                  remainingCloseMs(),
                );
              }),
            ]);
          } catch (error) {
            if (error === timeoutError) {
              void drain.catch(() => undefined);
              await nativeDriver
                .close(remainingCloseMs())
                .catch(() => undefined);
            }
            throw error;
          } finally {
            clearTimeout(timer);
          }
        })();
      }
      return closing;
    },
    [Symbol.asyncDispose]() {
      return this.close();
    },
  };
  function remainingCloseMs(): number | undefined {
    return closeDeadline === undefined
      ? undefined
      : Math.max(0, closeDeadline - performance.now());
  }
  async function runRetriedTransaction<T>(
    callback: (tx: YdbTransactionContext<C>) => PromiseLike<T>,
    transactionOptions?: YdbTransactionOptions,
  ): Promise<T> {
    const retry = transactionOptions?.retry;
    const maxAttempts =
      retry === true ? 5 : retry ? (retry.maxAttempts ?? 5) : 1;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)
      throw new TypeError('Transaction maxAttempts must be a positive integer');
    const mode = transactionOptions?.mode ?? 'serializable';
    if (mode !== 'serializable' && mode !== 'snapshotReadOnly')
      throw new TypeError(
        'Transaction mode must be serializable or snapshotReadOnly',
      );
    for (let attempt = 1; ; attempt++) {
      const state = { committed: false };
      try {
        return await runTransaction<T>(callback, state, mode);
      } catch (error) {
        const primary = primaryTransactionFailure(error);
        if (
          state.committed ||
          attempt >= maxAttempts ||
          !isRetryableYdbError(primary, false)
        )
          throw error;
        const delay = retryDelayMs(
          primary,
          attempt,
          nativeDriver.config.retry || retryDefaults,
        );
        // The pause ends early when the client closes; nothing is replayed then.
        if (delay)
          try {
            await sleep(delay, shutdown.signal);
          } catch {
            throw new SqlConnectionError(
              'YDB client closed before the transaction could be retried',
              { cause: error instanceof Error ? error : undefined },
            );
          }
      }
    }
  }
  async function runTransaction<T>(
    callback: (tx: YdbTransactionContext<C>) => PromiseLike<T>,
    state: { committed: boolean },
    mode: YdbTransactionMode,
  ): Promise<T> {
    if (!codecRegistryValidated) {
      validateCodecRegistryCompleteness(context.codecDescriptors, contract);
      codecRegistryValidated = true;
    }
    await ensureConnected();
    await warmMarker();
    const acquired = await nativeDriver.acquireConnection();
    let settled = false;
    let transaction:
      | Awaited<ReturnType<typeof acquired.beginTransaction>>
      | undefined;
    let scopedRuntime: Runtime | undefined;
    let result: Awaited<ReturnType<typeof callback>> | undefined;
    let failure: unknown;
    let failed = false;
    let mutationFailure: Error | undefined;
    let lastScopedFailure: unknown;
    const controller = new AbortController();
    let callbackTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      transaction = await acquired.beginTransaction({ mode });
      const checkActive = () => {
        if (settled) throw new Error('YDB transaction is already settled');
      };
      const queryable = transaction;
      const scopedDriver: SqlDriver<unknown> = {
        connect: async () => {
          checkActive();
        },
        async *query<Row>(request: SqlExecuteRequest) {
          checkActive();
          const linked = linkSignals(
            controller.signal,
            (request as SqlExecuteRequest & { signal?: AbortSignal }).signal,
          );
          try {
            yield* queryable.query<Row>({ ...request, signal: linked.signal });
          } catch (error) {
            lastScopedFailure = error;
            throw error;
          } finally {
            linked.dispose();
          }
        },
        async execute(request) {
          checkActive();
          const linked = linkSignals(
            controller.signal,
            (request as SqlExecuteRequest & { signal?: AbortSignal }).signal,
          );
          try {
            return await queryable.execute({
              ...request,
              signal: linked.signal,
            });
          } catch (error) {
            lastScopedFailure = error;
            throw error;
          } finally {
            linked.dispose();
          }
        },
        async acquireConnection() {
          throw new Error('Nested transactions are not supported by YDB');
        },
        async close() {
          /* The owning transaction settles and releases this connection. */
        },
      };
      scopedRuntime = makeRuntime(scopedDriver);
      markCodecsValidated(scopedRuntime);
      const failMutationScope = () => {
        if (!mutationFailure) {
          mutationFailure = new Error(
            'YDB transaction was invalidated by a failed nested mutation; savepoints are not supported',
            { cause: lastScopedFailure },
          );
          if (lastScopedFailure !== undefined)
            transactionPrimaryFailures.set(mutationFailure, lastScopedFailure);
        }
        settled = true;
        controller.abort(mutationFailure);
      };
      const scopedNative = {
        async executeYql(request: YdbQueryRequest) {
          const linked = linkSignals(controller.signal, request.signal);
          try {
            return await queryable.executeYql({
              ...request,
              signal: linked.signal,
            });
          } finally {
            linked.dispose();
          }
        },
      };
      const tx: YdbTransactionContext<C> = Object.defineProperties(
        members(scopedRuntime, scopedNative, checkActive, failMutationScope),
        {
          signal: { value: controller.signal, enumerable: true },
          invalidated: { get: () => settled, enumerable: true },
        },
      ) as YdbTransactionContext<C>;
      const callbackResult = Promise.resolve().then(() => callback(tx));
      const deadline = new Promise<never>((_resolve, reject) => {
        callbackTimer = setTimeout(() => {
          const error = new Error('YDB interactive transaction timed out');
          settled = true;
          controller.abort(error);
          reject(error);
        }, nativeDriver.config.transactionTimeoutMs);
        callbackTimer.unref();
      });
      result = await Promise.race([callbackResult, deadline]);
      clearTimeout(callbackTimer);
      if (mutationFailure) throw mutationFailure;
      await scopedRuntime.close();
      if (mutationFailure) throw mutationFailure;
      settled = true;
      await transaction.commit();
      state.committed = true;
    } catch (error) {
      failed = true;
      clearTimeout(callbackTimer);
      failure = controller.signal.aborted ? controller.signal.reason : error;
      settled = true;
      controller.abort(error);
      try {
        await scopedRuntime?.close();
      } catch (drainError) {
        failure = transactionFailure(
          failure,
          drainError,
          'YDB transaction failed while draining pending operations',
        );
      }
      // A statement-level commit already settled the transaction: never replay it.
      if (transaction?.committed) state.committed = true;
      else if (transaction) {
        try {
          await transaction.rollback();
        } catch (rollbackError) {
          failure = transactionFailure(
            failure,
            rollbackError,
            'YDB transaction failed and rollback also failed',
          );
        }
      }
    }
    try {
      // A definite begin/commit failure leaves a clean session; keep it pooled.
      if (acquired.reusable) await acquired.release();
      else await acquired.destroy();
    } catch (cleanupError) {
      acquired.abandon();
      failure = failed
        ? transactionFailure(
            failure,
            cleanupError,
            'YDB transaction failed and its session cleanup failed',
          )
        : cleanupError;
      failed = true;
    }
    if (failed) throw failure;
    return result as T;
  }
  return Object.defineProperties(
    lifecycle,
    Object.getOwnPropertyDescriptors(rootMembers),
  ) as YdbClient<C>;
}

export default ydb;
