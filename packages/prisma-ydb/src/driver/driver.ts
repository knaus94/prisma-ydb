import {
  SqlConnectionError,
  SqlQueryError,
} from '@prisma/orm-family-sql/errors';
import type {
  SqlDriver,
  SqlDriverState,
  SqlStatementStats,
} from '@prisma/orm-family-sql/relational-core/ast';
import { Driver } from '@ydbjs/core';
import { deadline, sleep } from './abort.js';
import { YdbConnection } from './connection.js';
import {
  isRetryableYdbError,
  normalizeError,
  YdbQueryError,
} from './errors.js';
import { emit } from './events.js';
import { resolveOptions, type Options } from './options.js';
import { retryDelayMs } from './retry.js';
import { ydbTableExists } from './scheme.js';
import { Semaphore } from './semaphore.js';
import { Session } from './session.js';
import type {
  YdbBinding,
  YdbDriverOptions,
  YdbHealth,
  YdbPoolStats,
  YdbQueryPart,
  YdbQueryRequest,
  YdbQueryResult,
  YdbRetryOptions,
  YdbSqlExecuteRequest,
} from './types.js';
import { isCompilerSelect, rowProjector, sqlRequest } from './values.js';

type Attempt<T> = (
  connection: YdbConnection,
  request: YdbQueryRequest,
) => AsyncIterable<T>;

/** Session pool plus the driver-owned statement path with bounded retries. */
export class YdbDriver implements SqlDriver<YdbBinding> {
  readonly config: Options;
  #core: Driver | undefined;
  #state: SqlDriverState = 'unbound';
  #connecting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  readonly #admission: Semaphore;
  #idle: Session[] = [];
  readonly #leased = new Set<YdbConnection>();
  /** Leases being prepared: admitted, but no handle handed out yet. */
  #pending = 0;
  readonly #cleanups = new Set<Promise<void>>();
  #sweep: ReturnType<typeof setInterval> | undefined;
  #drainers: (() => void)[] = [];

  constructor(input: YdbDriverOptions = {}) {
    this.config = resolveOptions(input);
    this.#admission = new Semaphore(
      this.config.maxSessions,
      this.config.maxWaiters,
    );
  }

  get stats(): YdbPoolStats {
    return {
      maxSessions: this.config.maxSessions,
      idle: this.#idle.length,
      leased: this.#leased.size,
      creating: this.#pending,
      waiters: this.#admission.waiters,
      closing: this.#cleanups.size,
    };
  }

  get state(): SqlDriverState {
    return this.#state;
  }

  /** Native SDK handle for control-plane Scheme/Table APIs; owned by this driver. */
  get core(): Driver {
    if (!this.#core || this.#state === 'unbound')
      throw new SqlConnectionError('YDB driver is not connected');
    return this.#core;
  }

  tableExists(name: string): Promise<boolean> {
    return ydbTableExists(this.core, name, this.config.queryTimeoutMs);
  }

  /** Readiness probe; never throws and never connects implicitly. */
  async health(
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<YdbHealth> {
    if (this.#lifecycle() !== 'connected')
      return { ready: false, state: this.#lifecycle(), pool: this.stats };
    const started = performance.now();
    try {
      await this.executeYql({
        text: 'SELECT 1',
        transactionMode: 'snapshotReadOnly',
        retry: false,
        idempotent: true,
        timeoutMs:
          options.timeoutMs ?? Math.min(5_000, this.config.queryTimeoutMs),
        signal: options.signal,
      });
      const state = this.#lifecycle();
      return {
        ready: state === 'connected',
        state,
        latencyMs: performance.now() - started,
        pool: this.stats,
      };
    } catch (error) {
      const failure = normalizeError(error, 'health');
      return {
        ready: false,
        state: this.#lifecycle(),
        latencyMs: performance.now() - started,
        pool: this.stats,
        error: {
          name: failure.name,
          message: failure.message,
          status: failure instanceof YdbQueryError ? failure.status : undefined,
        },
      };
    }
  }

  #lifecycle(): YdbHealth['state'] {
    if (this.#state === 'closed') return 'closed';
    if (this.#closing) return 'closing';
    if (this.#connecting) return 'connecting';
    return this.#state;
  }

  async connect(binding: YdbBinding): Promise<void> {
    if (this.#state === 'closed' || this.#closing)
      throw new SqlConnectionError('YDB driver is closed');
    if (this.#state === 'connected') return;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect(binding);
    try {
      await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect(binding: YdbBinding): Promise<void> {
    const started = performance.now();
    const core = new Driver(binding.url, binding.driverOptions);
    const scope = deadline(this.config.acquireTimeoutMs);
    try {
      await core.ready(scope.signal);
      if (this.#closing) throw new SqlConnectionError('YDB driver is closing');
      this.#core = core;
      this.#state = 'connected';
      await this.#warm();
      if (!this.#closing) {
        const interval = Math.min(
          this.config.sessionMaxIdleMs,
          this.config.sessionMaxAgeMs,
          30_000,
        );
        this.#sweep = setInterval(() => {
          this.#sweepIdle();
          void this.#warm();
        }, interval);
        this.#sweep.unref();
      }
      emit(this, 'connect', started);
    } catch (error) {
      core.close();
      const failure = normalizeError(
        error,
        'connect',
        false,
        this.config.includeServerIssues,
      );
      emit(this, 'connect', started, failure);
      throw failure;
    } finally {
      scope.dispose();
    }
  }

  async acquireConnection(requestSignal?: AbortSignal): Promise<YdbConnection> {
    if (this.#state !== 'connected' || this.#closing)
      throw new SqlConnectionError('YDB driver is not connected or is closing');
    const started = performance.now();
    const scope = deadline(this.config.acquireTimeoutMs, requestSignal);
    let release: (() => void) | undefined;
    let failure: unknown;
    try {
      release = await this.#admission.acquire(scope.signal);
      this.#pending++;
      const session =
        this.#takeIdle() ?? (await this.#openSession(scope.signal));
      if (this.#closing) {
        this.#retire(session);
        throw new SqlConnectionError('YDB driver is closing');
      }
      const lease = release;
      const connection = new YdbConnection(session, this, (reusable) => {
        this.#leased.delete(connection);
        if (reusable && this.#fresh(session) && !this.#closing) {
          session.idleSince = Date.now();
          this.#idle.push(session);
        } else if (reusable) this.#retire(session);
        lease();
        this.#notifyDrain();
      });
      this.#leased.add(connection);
      return connection;
    } catch (error) {
      release?.();
      failure = normalizeError(
        error,
        'acquire',
        false,
        this.config.includeServerIssues,
      );
      throw failure;
    } finally {
      scope.dispose();
      if (release) this.#pending--;
      this.#notifyDrain();
      emit(this, 'acquire', started, failure);
    }
  }

  queryYql(request: YdbQueryRequest): AsyncIterable<YdbQueryPart> {
    return this.#run(request, (connection, attempt) =>
      connection.queryYql(attempt),
    );
  }

  async executeYql(request: YdbQueryRequest): Promise<YdbQueryResult> {
    for await (const result of this.#run(
      request,
      async function* (connection, attempt) {
        yield await connection.executeYql(attempt);
      },
    ))
      return result;
    throw new SqlQueryError('YDB query returned no result');
  }

  async *query<Row = Record<string, unknown>>(
    request: YdbSqlExecuteRequest,
  ): AsyncIterable<Row> {
    const project = rowProjector(request.sql);
    const result = await this.executeYql(sqlRequest(request));
    for (const set of result.resultSets)
      for (const row of set?.rows ?? []) yield project(row) as Row;
  }

  async execute(request: YdbSqlExecuteRequest): Promise<SqlStatementStats> {
    const result = await this.executeYql(sqlRequest(request, true));
    return { affectedRows: result.affectedRows };
  }

  /**
   * Driver-owned execution: one lease per attempt, bounded retries within the
   * request deadline. Nothing is replayed once a part has been yielded.
   */
  async *#run<T>(
    request: YdbQueryRequest,
    attempt: Attempt<T>,
  ): AsyncIterable<T> {
    const timeout = request.timeoutMs ?? this.config.queryTimeoutMs;
    const scope = deadline(timeout, request.signal);
    const expires = performance.now() + timeout;
    const policy = this.#retryPolicy(request);
    const idempotent =
      request.idempotent === true ||
      request.transactionMode === 'snapshotReadOnly' ||
      isCompilerSelect(request.text);
    let yielded = false;
    try {
      for (let attempts = 1; ; attempts++) {
        let connection: YdbConnection | undefined;
        let failure: unknown;
        try {
          scope.signal.throwIfAborted();
          connection = await this.acquireConnection(scope.signal);
          const bounded: YdbQueryRequest = {
            ...request,
            signal: scope.signal,
            timeoutMs: Math.max(1, Math.ceil(expires - performance.now())),
          };
          for await (const item of attempt(connection, bounded)) {
            yielded = true;
            yield item;
          }
          return;
        } catch (error) {
          failure = error;
        } finally {
          if (connection) await this.#return(connection);
        }
        const retryable =
          policy &&
          !yielded &&
          attempts < policy.maxAttempts &&
          !scope.signal.aborted &&
          isRetryableYdbError(failure, idempotent);
        if (!retryable) throw failure;
        const delay = retryDelayMs(failure, attempts, policy);
        if (delay + 1 >= expires - performance.now()) throw failure;
        emit(this, 'retry', performance.now(), failure, attempts + 1);
        if (delay) await sleep(delay, scope.signal);
      }
    } finally {
      scope.dispose();
    }
  }

  #retryPolicy(request: YdbQueryRequest): false | Required<YdbRetryOptions> {
    if (request.retry === false) return false;
    // DDL and other implicit-mode statements are replayed only on explicit request.
    if (request.transactionMode === 'implicit' && request.retry !== true)
      return false;
    return this.config.retry;
  }

  async #return(connection: YdbConnection): Promise<void> {
    if (connection.reusable) await connection.release();
    else this.#cleanup(connection.destroy().catch(() => connection.abandon()));
  }

  #fresh(session: Session): boolean {
    return (
      session.alive &&
      Date.now() - session.createdAt < this.config.sessionMaxAgeMs
    );
  }

  #takeIdle(): Session | undefined {
    for (;;) {
      const session = this.#idle.pop();
      if (!session || this.#fresh(session)) return session;
      this.#retire(session);
    }
  }

  async #openSession(signal: AbortSignal): Promise<Session> {
    const started = performance.now();
    let failure: unknown;
    try {
      return await Session.open({
        core: this.core,
        signal,
        closeTimeoutMs: this.config.sessionCloseTimeoutMs,
        maxWaiters: this.config.maxWaiters,
      });
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      emit(this, 'session-create', started, failure);
    }
  }

  /** Background, bounded server-side cleanup; close() waits for it. */
  #cleanup(work: Promise<void>): void {
    const settled: Promise<void> = work
      .catch(() => undefined)
      .finally(() => {
        this.#cleanups.delete(settled);
        this.#notifyDrain();
      });
    this.#cleanups.add(settled);
  }

  #retire(session: Session): void {
    const started = performance.now();
    this.#cleanup(
      session.close().then(
        () => emit(this, 'destroy', started),
        (error) => emit(this, 'destroy', started, error),
      ),
    );
  }

  #sweepIdle(): void {
    const now = Date.now();
    let keep = this.#idle.length;
    this.#idle = this.#idle.filter((session) => {
      const expired =
        !this.#fresh(session) ||
        (keep > this.config.minSessions &&
          now - session.idleSince >= this.config.sessionMaxIdleMs);
      if (!expired) return true;
      keep--;
      this.#retire(session);
      return false;
    });
  }

  /** Best-effort warm-up to minSessions; never waits for a busy pool. */
  async #warm(): Promise<void> {
    const missing =
      this.config.minSessions -
      this.#idle.length -
      this.#leased.size -
      this.#pending;
    if (missing <= 0 || this.#closing) return;
    await Promise.all(
      Array.from({ length: missing }, async () => {
        const release = this.#admission.tryAcquire();
        if (!release) return;
        this.#pending++;
        const scope = deadline(this.config.acquireTimeoutMs);
        try {
          const session = await this.#openSession(scope.signal);
          if (this.#closing) this.#retire(session);
          else this.#idle.push(session);
        } catch {
          /* Reported through the session-create event; connect() still succeeds. */
        } finally {
          scope.dispose();
          release();
          this.#pending--;
          this.#notifyDrain();
        }
      }),
    );
  }

  close(timeoutMs = this.config.closeTimeoutMs): Promise<void> {
    if (this.#closing) return this.#closing;
    if (!Number.isFinite(timeoutMs))
      throw new TypeError('YDB close timeoutMs must be finite');
    this.#closing = this.#close(Math.max(1, Math.ceil(timeoutMs)));
    return this.#closing;
  }

  async #close(timeoutMs: number): Promise<void> {
    this.#admission.close();
    clearInterval(this.#sweep);
    const scope = deadline(timeoutMs);
    let abandoned: number | undefined;
    const drain = async (): Promise<void> => {
      if (this.#connecting) await this.#connecting.catch(() => undefined);
      if (this.#leased.size || this.#pending || this.#cleanups.size)
        await new Promise<void>((resolve) => this.#drainers.push(resolve));
      const results = await Promise.allSettled(
        this.#idle.splice(0).map((session) => session.close()),
      );
      await this.#core?.[Symbol.asyncDispose]();
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
    };
    const expire = new Promise<void>((resolve) =>
      scope.signal.addEventListener(
        'abort',
        () => {
          abandoned = this.#leased.size;
          for (const connection of [...this.#leased]) connection.abandon();
          for (const session of this.#idle.splice(0)) session.dispose();
          this.#core?.close();
          resolve();
        },
        { once: true },
      ),
    );
    try {
      await Promise.race([drain(), expire]);
    } finally {
      scope.dispose();
      this.#state = 'closed';
    }
    if (abandoned !== undefined)
      throw new SqlConnectionError(
        `YDB close timed out; abandoned ${abandoned} leases`,
      );
  }

  #notifyDrain(): void {
    if (!this.#leased.size && !this.#pending && !this.#cleanups.size)
      for (const resolve of this.#drainers.splice(0)) resolve();
  }
}
