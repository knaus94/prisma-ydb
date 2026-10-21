import {
  SqlConnectionError,
  SqlQueryError,
} from '@prisma/orm-family-sql/errors';
import type {
  SqlConnection,
  SqlStatementStats,
  SqlTransaction,
} from '@prisma/orm-family-sql/relational-core/ast';
import type { MessageInitShape } from '@bufbuild/protobuf';
import {
  ExecMode,
  StatsMode,
  Syntax,
  type ExecuteQueryRequestSchema,
  type ExecuteQueryResponsePart,
  type QueryStats,
} from '@ydbjs/api/query';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { deadline, type Scope } from './abort.js';
import {
  checkStatus,
  normalizeError,
  taintsSession,
  YdbQueryError,
} from './errors.js';
import { emit, type EventSink } from './events.js';
import type { Options } from './options.js';
import type { Session } from './session.js';
import type {
  YdbQueryPart,
  YdbQueryRequest,
  YdbQueryResult,
  YdbResultSet,
  YdbSqlExecuteRequest,
} from './types.js';
import {
  decodeValue,
  encodeParameters,
  isCompilerSelect,
  estimateSize,
  rowProjector,
  sqlRequest,
} from './values.js';

type TransactionMode = NonNullable<YdbQueryRequest['transactionMode']>;

/** Compiler-tagged SELECTs follow the configured read mode; everything else is serializable. */
export function transactionModeOf(
  request: YdbQueryRequest,
  config: Options,
): TransactionMode {
  if (request.transactionMode) return request.transactionMode;
  return isCompilerSelect(request.text)
    ? config.readTransactionMode
    : 'serializable';
}

function txControl(
  mode: TransactionMode,
  transaction: { id: string } | undefined,
): Pick<MessageInitShape<typeof ExecuteQueryRequestSchema>, 'txControl'> {
  if (transaction)
    return {
      txControl: { txSelector: { case: 'txId', value: transaction.id } },
    };
  if (mode === 'implicit') return {};
  return {
    txControl: {
      commitTx: true,
      txSelector: {
        case: 'beginTx',
        value: {
          txMode:
            mode === 'snapshotReadOnly'
              ? { case: 'snapshotReadOnly', value: {} }
              : { case: 'serializableReadWrite', value: {} },
        },
      },
    },
  };
}

/** Decode one streamed part with a column plan built once, not once per cell. */
function decodePart(
  part: ExecuteQueryResponsePart,
  wire: boolean,
): YdbQueryPart {
  if (part.resultSet?.truncated)
    throw new SqlQueryError('YDB truncated the result; paginate the query');
  const columns = part.resultSet?.columns ?? [];
  const names = new Set<string>();
  const plan = columns.map((column) => {
    const type = column.type;
    if (!type) throw new SqlQueryError('YDB returned an invalid row');
    if (names.has(column.name))
      throw new SqlQueryError(
        'YDB returned duplicate column names; use aliases',
      );
    names.add(column.name);
    return { name: column.name, type };
  });
  const rows = (part.resultSet?.rows ?? []).map((row) => {
    const object: Record<string, unknown> = Object.create(null);
    for (let index = 0; index < plan.length; index++) {
      const value = row.items[index];
      if (!value) throw new SqlQueryError('YDB returned an invalid row');
      const { name, type } = plan[index];
      object[name] = wire ? value : decodeValue(value, type);
    }
    return object;
  });
  return {
    resultSetIndex: Number(part.resultSetIndex),
    columns,
    rows,
    stats: part.execStats,
  };
}

async function collect(
  parts: AsyncIterable<YdbQueryPart>,
  request: YdbQueryRequest,
  config: Options,
): Promise<YdbQueryResult> {
  const resultSets: YdbResultSet[] = [];
  let stats: QueryStats | undefined;
  let rowCount = 0;
  let bytes = 0;
  for await (const part of parts) {
    if (part.stats) stats = part.stats;
    if (!part.columns.length && !part.rows.length) continue;
    // A malicious/unexpected wire index cannot allocate an unbounded sparse result array.
    if (
      !Number.isSafeInteger(part.resultSetIndex) ||
      part.resultSetIndex < 0 ||
      part.resultSetIndex > 1_024
    )
      throw new SqlQueryError('YDB returned an invalid result-set index');
    let target = resultSets[part.resultSetIndex];
    if (!target)
      resultSets[part.resultSetIndex] = target = {
        columns: part.columns,
        rows: [],
      };
    for (const row of part.rows) {
      bytes += estimateSize(row);
      if (++rowCount > config.maxResultRows || bytes > config.maxResultBytes)
        throw new SqlQueryError(
          'YDB buffered result limit exceeded; use queryYql streaming or paginate the query',
        );
      target.rows.push(row);
    }
  }
  return {
    resultSets,
    stats,
    affectedRows: request.affectedRows === 'returning' ? rowCount : 0,
  };
}

interface ActiveTransaction {
  readonly id: string;
  readonly deadline: Scope;
  failed: boolean;
}

/** A pooled session lease. Serial by construction: one statement at a time. */
export class YdbConnection implements SqlConnection {
  readonly #session: Session;
  readonly #sink: EventSink;
  readonly #returned: (reusable: boolean) => void;
  #closed = false;
  #tainted = false;
  #destroying = false;
  #busy = 0;
  #waiting = 0;
  #streams = 0;
  #transaction: ActiveTransaction | undefined;

  constructor(
    session: Session,
    sink: EventSink,
    returned: (reusable: boolean) => void,
  ) {
    this.#session = session;
    this.#sink = sink;
    this.#returned = returned;
  }

  get #config(): Options {
    return this.#sink.config;
  }

  /** Clean handles go back to the pool; anything else must be destroyed. */
  get reusable(): boolean {
    return (
      !this.#closed &&
      !this.#tainted &&
      !this.#destroying &&
      this.#session.alive &&
      !this.#transaction &&
      this.#busy === 0 &&
      this.#waiting === 0 &&
      this.#streams === 0
    );
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new SqlConnectionError('YDB connection has been released');
    if (this.#tainted || this.#destroying || !this.#session.alive)
      throw new SqlConnectionError('YDB connection must be destroyed');
  }

  /** Take the session's serial lock; waiting handles are not reusable. */
  async #lock(signal: AbortSignal): Promise<() => void> {
    this.#waiting++;
    try {
      return await this.#session.serial.acquire(signal);
    } finally {
      this.#waiting--;
    }
  }

  #activeTransaction(
    expectedId: string | undefined,
  ): ActiveTransaction | undefined {
    const transaction = this.#transaction;
    if (expectedId !== undefined && transaction?.id !== expectedId)
      throw new SqlQueryError('YDB transaction handle is no longer active');
    if (transaction?.failed)
      throw new SqlQueryError(
        'YDB transaction failed; roll it back before issuing another query',
      );
    return transaction;
  }

  async *queryYql(
    request: YdbQueryRequest,
    expectedTransactionId?: string,
  ): AsyncIterable<YdbQueryPart> {
    this.#assertOpen();
    const mode = transactionModeOf(request, this.#config);
    // Validate before opening the RPC; validation failure does not taint a session.
    const parameters = encodeParameters(request.parameters);
    const started = performance.now();
    const cancel = new AbortController();
    const scope = deadline(
      request.timeoutMs ?? this.#config.queryTimeoutMs,
      request.signal,
      this.#session.life.signal,
    );
    let rpc: Scope | undefined;
    let release: (() => void) | undefined;
    // 'streaming' means the server has not sent a terminal status yet.
    let phase: 'pending' | 'streaming' | 'terminal' = 'pending';
    let failure: unknown;
    try {
      release = await this.#lock(scope.signal);
      this.#busy++;
      this.#assertOpen();
      const transaction = this.#activeTransaction(expectedTransactionId);
      rpc = deadline(
        undefined,
        scope.signal,
        cancel.signal,
        transaction?.deadline.signal,
      );
      rpc.signal.throwIfAborted();
      phase = 'streaming';
      const parts = this.#session.client.executeQuery(
        {
          sessionId: this.#session.id,
          execMode: ExecMode.EXECUTE,
          query: {
            case: 'queryContent',
            value: { text: request.text, syntax: Syntax.YQL_V1 },
          },
          parameters,
          statsMode:
            (request.stats ?? this.#config.statsMode) === 'basic'
              ? StatsMode.BASIC
              : StatsMode.NONE,
          ...txControl(mode, transaction),
        },
        { signal: rpc.signal },
      );
      for await (const part of parts) {
        if (part.status !== Status.SUCCESS) {
          // A failure status ends the stream; the session itself stays usable.
          phase = 'terminal';
          checkStatus(part);
        }
        yield decodePart(part, request.valueMode === 'wire');
      }
      phase = 'terminal';
    } catch (error) {
      failure = normalizeError(
        error,
        'query',
        !this.#transaction && mode !== 'snapshotReadOnly',
        this.#config.includeServerIssues,
      );
      if (phase !== 'pending' && this.#transaction)
        this.#transaction.failed = true;
      if (taintsSession(failure) || !this.#session.alive) this.#tainted = true;
      throw failure;
    } finally {
      if (phase === 'streaming') {
        // Cancelled before the terminal status: the server-side outcome is unknown.
        cancel.abort();
        this.#tainted = true;
      }
      if (release) {
        this.#busy--;
        release();
      }
      scope.dispose();
      rpc?.dispose();
      emit(
        this.#sink,
        'query',
        started,
        failure ??
          (phase !== 'terminal'
            ? new Error('Stream returned early')
            : undefined),
      );
    }
  }

  executeYql(
    request: YdbQueryRequest,
    expectedTransactionId?: string,
  ): Promise<YdbQueryResult> {
    return collect(
      this.queryYql(request, expectedTransactionId),
      request,
      this.#config,
    );
  }

  async *query<Row = Record<string, unknown>>(
    request: YdbSqlExecuteRequest,
    expectedTransactionId?: string,
  ): AsyncIterable<Row> {
    this.#streams++;
    try {
      const project = rowProjector(request.sql);
      const result = await this.executeYql(
        sqlRequest(request),
        expectedTransactionId,
      );
      for (const set of result.resultSets)
        for (const row of set?.rows ?? []) yield project(row) as Row;
    } finally {
      this.#streams--;
    }
  }

  async execute(
    request: YdbSqlExecuteRequest,
    expectedTransactionId?: string,
  ): Promise<SqlStatementStats> {
    const result = await this.executeYql(
      sqlRequest(request, true),
      expectedTransactionId,
    );
    return { affectedRows: result.affectedRows };
  }

  beginTransaction(): Promise<YdbTransaction> {
    return this.#operation('begin', async (signal) => {
      this.#assertOpen();
      if (this.#transaction)
        throw new SqlQueryError('Nested YDB transactions are not supported');
      const response = await this.#session.client.beginTransaction(
        {
          sessionId: this.#session.id,
          txSettings: { txMode: { case: 'serializableReadWrite', value: {} } },
        },
        { signal },
      );
      checkStatus(response);
      const id = response.txMeta?.id;
      if (!id)
        throw new SqlQueryError('YDB did not return a transaction identifier');
      this.#transaction = {
        id,
        deadline: deadline(this.#config.transactionTimeoutMs),
        failed: false,
      };
      return new YdbTransaction(this, id);
    });
  }

  async finishTransaction(id: string, commit: boolean): Promise<void> {
    await this.#operation(commit ? 'commit' : 'rollback', async (signal) => {
      const transaction = this.#transaction;
      if (!transaction || transaction.id !== id)
        throw new SqlQueryError('YDB transaction is no longer active');
      if (commit && (transaction.failed || transaction.deadline.signal.aborted))
        throw new SqlQueryError(
          'Failed or expired YDB transactions must be rolled back',
        );
      const request = { sessionId: this.#session.id, txId: id };
      const response = commit
        ? await this.#session.client.commitTransaction(request, { signal })
        : await this.#session.client.rollbackTransaction(request, { signal });
      // ABORTED/NOT_FOUND acknowledge that no live transaction remains to roll back.
      if (commit || !rolledBackStatuses.has(response.status))
        checkStatus(response);
      transaction.deadline.dispose();
      this.#transaction = undefined;
    });
  }

  async #operation<T>(
    operation: 'begin' | 'commit' | 'rollback',
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.#closed)
      throw new SqlConnectionError('YDB connection has been released');
    const started = performance.now();
    const scope = deadline(
      this.#config.queryTimeoutMs,
      undefined,
      this.#session.life.signal,
      operation === 'commit' ? this.#transaction?.deadline.signal : undefined,
    );
    let release: (() => void) | undefined;
    let failure: unknown;
    try {
      release = await this.#lock(scope.signal);
      this.#busy++;
      if (this.#closed)
        throw new SqlConnectionError('YDB connection has been released');
      return await run(scope.signal);
    } catch (error) {
      failure = normalizeError(
        error,
        operation,
        operation === 'commit',
        this.#config.includeServerIssues,
      );
      // Local precondition failures never reached the server and change nothing.
      const local =
        error instanceof SqlQueryError || error instanceof SqlConnectionError;
      if (!local) {
        if (this.#transaction) this.#transaction.failed = true;
        // A definite commit failure (e.g. ABORTED) leaves a healthy session whose
        // transaction only needs a rollback; unknown outcomes cannot be trusted.
        if (
          taintsSession(failure) ||
          (failure instanceof YdbQueryError && failure.outcomeUnknown) ||
          operation === 'rollback'
        )
          this.#tainted = true;
      }
      throw failure;
    } finally {
      if (release) {
        this.#busy--;
        release();
      }
      scope.dispose();
      if (operation !== 'begin') this.#transaction?.deadline.dispose();
      emit(this.#sink, operation, started, failure);
    }
  }

  async release(): Promise<void> {
    if (!this.reusable)
      throw new SqlConnectionError(
        'YDB connection is not clean; destroy it instead of releasing it',
      );
    this.#closed = true;
    this.#returned(true);
  }

  /** Delete the session on the server; cleanup failures are reported, not thrown. */
  async destroy(reason?: unknown): Promise<void> {
    void reason; // Advisory only: disposal behavior never depends on the caller's reason.
    if (this.#closed || this.#destroying)
      throw new SqlConnectionError('YDB connection has already been disposed');
    if (this.#busy || this.#streams)
      throw new SqlConnectionError(
        'Return the active YDB stream before destroying its connection',
      );
    const started = performance.now();
    this.#tainted = true;
    this.#destroying = true;
    let failure: unknown;
    try {
      await this.#session.close();
    } catch (error) {
      failure = error;
    } finally {
      this.#transaction?.deadline.dispose();
      this.#session.dispose();
      this.#closed = true;
      this.#returned(false);
      emit(this.#sink, 'destroy', started, failure);
    }
  }

  /** Internal last-resort cleanup for a driver-owned handle after server teardown fails. */
  abandon(): void {
    if (this.#closed) return;
    this.#transaction?.deadline.dispose();
    this.#session.dispose();
    this.#closed = true;
    this.#returned(false);
  }
}

export class YdbTransaction implements SqlTransaction {
  constructor(
    private readonly connection: YdbConnection,
    private readonly id: string,
  ) {}
  query<Row = Record<string, unknown>>(
    request: YdbSqlExecuteRequest,
  ): AsyncIterable<Row> {
    return this.connection.query<Row>(request, this.id);
  }
  execute(request: YdbSqlExecuteRequest): Promise<SqlStatementStats> {
    return this.connection.execute(request, this.id);
  }
  queryYql(request: YdbQueryRequest): AsyncIterable<YdbQueryPart> {
    return this.connection.queryYql(request, this.id);
  }
  executeYql(request: YdbQueryRequest): Promise<YdbQueryResult> {
    return this.connection.executeYql(request, this.id);
  }
  commit(): Promise<void> {
    return this.connection.finishTransaction(this.id, true);
  }
  rollback(): Promise<void> {
    return this.connection.finishTransaction(this.id, false);
  }
}

const rolledBackStatuses = new Set<number>([Status.ABORTED, Status.NOT_FOUND]);
