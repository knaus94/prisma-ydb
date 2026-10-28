import { SqlConnectionError } from '@prisma/orm-family-sql/errors';
import type {
  SqlDriver,
  SqlDriverState,
  SqlStatementStats,
} from '@prisma/orm-family-sql/relational-core/ast';
import { TableServiceDefinition } from '@ydbjs/api/table';
import { Driver } from '@ydbjs/core';
import { deadline, sleep, type Scope } from './abort.js';
import { YdbConnection } from './connection.js';
import {
  checkOperation,
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
  YdbBulkUpsertRequest,
  YdbDriverOptions,
  YdbHealth,
  YdbPoolStats,
  YdbQueryPart,
  YdbQueryRequest,
  YdbQueryResult,
  YdbRetryOptions,
  YdbSqlExecuteRequest,
} from './types.js';
import {
  encodeParameters,
  isCompilerSelect,
  rowProjector,
  sqlRequest,
} from './values.js';

/** One driver-owned request: deadline shared by all attempts plus the retry decision. */
interface Run {
  readonly scope: Scope;
  /** The request bounded to the remaining budget for the next attempt. */
  bound(): YdbQueryRequest;
  /** Resolves after the backoff pause when a retry is allowed; otherwise rethrows. */
  backoff(failure: unknown, attempts: number, yielded: boolean): Promise<void>;
}

/** Session pool plus the driver-owned statement path with bounded retries. */
export class YdbDriver implements SqlDriver<YdbBinding> {
  readonly config: Options;
  #core: Driver | undefined;
  #state: SqlDriverState = 'unbound';
  #connecting: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  readonly #admission: Semaphore;
  /** Bounds leases handed out through acquireConnection(); statements bypass it. */
  readonly #holding: Semaphore;
  #held = 0;
  readonly #paths = {
    autocommit: { active: 0, total: 0, errors: 0 },
    streaming: { active: 0, total: 0, errors: 0, abandoned: 0 },
    bulkUpsert: { active: 0, total: 0, errors: 0 },
    held: { active: 0, total: 0, errors: 0 },
  };
  #tables:
    | ReturnType<
        typeof Driver.prototype.createClient<typeof TableServiceDefinition>
      >
    | undefined;
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
    this.#holding = new Semaphore(
      this.config.maxTransactionSessions,
      this.config.maxWaiters,
    );
  }

  get stats(): YdbPoolStats {
    return {
      paths: {
        autocommit: { ...this.#paths.autocommit },
        streaming: { ...this.#paths.streaming },
        bulkUpsert: { ...this.#paths.bulkUpsert },
        held: { ...this.#paths.held },
      },
      maxSessions: this.config.maxSessions,
      idle: this.#idle.length,
      leased: this.#leased.size,
      held: this.#held,
      creating: this.#pending,
      waiters: this.#admission.waiters + this.#holding.waiters,
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

  /**
   * A lease the caller holds across statements (interactive transactions,
   * Prisma mutation graphs, explicit connections); counted against
   * maxTransactionSessions so slow callbacks cannot starve autocommit traffic.
   */
  acquireConnection(requestSignal?: AbortSignal): Promise<YdbConnection> {
    return this.#lease(requestSignal, true);
  }

  async #lease(
    requestSignal: AbortSignal | undefined,
    held: boolean,
  ): Promise<YdbConnection> {
    if (held) this.#paths.held.total++;
    if (this.#state !== 'connected' || this.#closing) {
      if (held) this.#paths.held.errors++;
      throw new SqlConnectionError('YDB driver is not connected or is closing');
    }
    const started = performance.now();
    const scope = deadline(this.config.acquireTimeoutMs, requestSignal);
    let hold: (() => void) | undefined;
    let release: (() => void) | undefined;
    let failure: unknown;
    try {
      if (held) hold = await this.#holding.acquire(scope.signal);
      release = await this.#admission.acquire(scope.signal);
      this.#pending++;
      const session =
        this.#takeIdle() ?? (await this.#openSession(scope.signal));
      if (this.#closing) {
        this.#retire(session);
        throw new SqlConnectionError('YDB driver is closing');
      }
      const lease = release;
      const unhold = hold;
      const connection = new YdbConnection(session, this, (reusable) => {
        this.#leased.delete(connection);
        if (unhold) {
          this.#held--;
          this.#paths.held.active--;
          if (connection.failed || !reusable) this.#paths.held.errors++;
        }
        if (reusable && this.#fresh(session) && !this.#closing) {
          session.idleSince = Date.now();
          this.#idle.push(session);
        } else if (reusable) this.#retire(session);
        lease();
        unhold?.();
        this.#notifyDrain();
      });
      this.#leased.add(connection);
      if (unhold) {
        this.#held++;
        this.#paths.held.active++;
      }
      return connection;
    } catch (error) {
      if (held) this.#paths.held.errors++;
      release?.();
      hold?.();
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

  /**
   * Driver-owned streaming: one lease per attempt, bounded retries within the
   * request deadline. Nothing is replayed once a part has been yielded.
   */
  async *queryYql(request: YdbQueryRequest): AsyncIterable<YdbQueryPart> {
    const stats = this.#paths.streaming;
    stats.active++;
    stats.total++;
    let run: Run | undefined;
    let complete = false;
    let yielded = false;
    try {
      run = this.#plan(request);
      for (let attempts = 1; ; attempts++) {
        let connection: YdbConnection | undefined;
        let failure: unknown;
        try {
          run.scope.signal.throwIfAborted();
          connection = await this.#lease(run.scope.signal, false);
          for await (const part of connection.queryYql(run.bound())) {
            yielded = true;
            yield part;
          }
          complete = true;
          return;
        } catch (error) {
          failure = error;
        } finally {
          if (connection) await this.#return(connection);
        }
        await run.backoff(failure, attempts, yielded);
      }
    } catch (error) {
      stats.errors++;
      complete = true;
      throw error;
    } finally {
      stats.active--;
      if (!complete) stats.abandoned++;
      run?.scope.dispose();
    }
  }

  /** Buffered execution with the same lease/retry policy as queryYql. */
  async executeYql(request: YdbQueryRequest): Promise<YdbQueryResult> {
    const stats = this.#paths.autocommit;
    stats.active++;
    stats.total++;
    let run: Run | undefined;
    try {
      run = this.#plan(request);
      for (let attempts = 1; ; attempts++) {
        let connection: YdbConnection | undefined;
        let failure: unknown;
        try {
          run.scope.signal.throwIfAborted();
          connection = await this.#lease(run.scope.signal, false);
          return await connection.executeYql(run.bound());
        } catch (error) {
          failure = error;
        } finally {
          if (connection) await this.#return(connection);
        }
        await run.backoff(failure, attempts, false);
      }
    } catch (error) {
      stats.errors++;
      throw error;
    } finally {
      stats.active--;
      run?.scope.dispose();
    }
  }

  async *query<Row = Record<string, unknown>>(
    request: YdbSqlExecuteRequest,
  ): AsyncIterable<Row> {
    const project = rowProjector(request.sql);
    const result = await this.executeYql(
      sqlRequest(request, this.config.readTransactionMode),
    );
    for (const set of result.resultSets)
      for (const row of set?.rows ?? []) yield project(row) as Row;
  }

  async execute(request: YdbSqlExecuteRequest): Promise<SqlStatementStats> {
    const result = await this.executeYql(
      sqlRequest(request, this.config.readTransactionMode, true),
    );
    return { affectedRows: result.affectedRows };
  }

  /**
   * Rows as they arrive, without the buffered result bounds. Retries stop at
   * the first row; abandoning the iterator cancels the RPC and discards its session.
   */
  async *stream<Row = Record<string, unknown>>(
    request: YdbSqlExecuteRequest,
  ): AsyncIterable<Row> {
    const project = rowProjector(request.sql);
    for await (const part of this.queryYql(
      sqlRequest(request, this.config.readTransactionMode),
    ))
      for (const row of part.rows) yield project(row) as Row;
  }

  /** TableService BulkUpsert: idempotent, outside any transaction, retried like a read. */
  async bulkUpsert(request: YdbBulkUpsertRequest): Promise<void> {
    const stats = this.#paths.bulkUpsert;
    stats.active++;
    stats.total++;
    let run: Run | undefined;
    const started = performance.now();
    let failure: unknown;
    try {
      const rows = encodeParameters({ rows: request.rows })['$rows'];
      const table = request.table.startsWith('/')
        ? request.table
        : `${this.core.database}/${request.table}`;
      run = this.#plan({
        text: '',
        signal: request.signal,
        timeoutMs: request.timeoutMs,
        idempotent: true,
        retry: request.retry,
      });
      for (let attempts = 1; ; attempts++) {
        try {
          run.scope.signal.throwIfAborted();
          this.#tables ??= this.core.createClient(TableServiceDefinition);
          const response = await this.#tables.bulkUpsert(
            { table, rows },
            { signal: run.scope.signal },
          );
          checkOperation(response.operation);
          return;
        } catch (error) {
          failure = normalizeError(
            error,
            'bulk upsert',
            false,
            this.config.includeServerIssues,
          );
        }
        await run.backoff(failure, attempts, false);
        failure = undefined;
      }
    } catch (error) {
      stats.errors++;
      failure = error;
      throw error;
    } finally {
      stats.active--;
      run?.scope.dispose();
      emit(this, 'bulk-upsert', started, failure);
    }
  }

  #plan(request: YdbQueryRequest): Run {
    const timeout = request.timeoutMs ?? this.config.queryTimeoutMs;
    const scope = deadline(timeout, request.signal);
    const expires = performance.now() + timeout;
    const policy = this.#retryPolicy(request);
    const idempotent =
      request.idempotent === true ||
      request.transactionMode === 'snapshotReadOnly' ||
      isCompilerSelect(request.text);
    return {
      scope,
      bound: () => ({
        ...request,
        signal: scope.signal,
        timeoutMs: Math.max(1, Math.ceil(expires - performance.now())),
      }),
      backoff: async (failure, attempts, yielded) => {
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
      },
    };
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
    this.#holding.close();
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
