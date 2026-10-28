import { ExecMode, StatsMode } from '@ydbjs/api/query';
import { Session } from '../driver/session.js';
import { checkStatus } from '../driver/errors.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { SqlControlDriverInstance } from '@prisma/orm-family-sql/contract/types';
import type { ControlDriverDescriptor } from '@prisma/orm-framework/components/control';
import { YdbDriver, type YdbTransaction } from '../driver/index.js';
import type {
  YdbBinding,
  YdbQueryRequest,
  YdbQueryResult,
} from '../driver/types.js';

/** Pins control-plane DML to one serializable transaction when requested. */
export class YdbControlDriver implements SqlControlDriverInstance<'ydb'> {
  readonly familyId = 'sql' as const;
  readonly targetId = 'ydb' as const;
  private readonly transactions = new AsyncLocalStorage<YdbTransaction>();
  constructor(readonly native: YdbDriver) {}
  get core() {
    return this.native.core;
  }
  async close(): Promise<void> {
    await this.native.close();
  }
  /** Control-only type inference: QueryService EXPLAIN never executes the query. */
  async explainYql(text: string): Promise<{ ast: string; plan: string }> {
    const scope = new AbortController();
    const timeout = setTimeout(
      () => scope.abort(new Error('YQL EXPLAIN timed out')),
      30_000,
    );
    let session: Session | undefined;
    try {
      session = await Session.open({
        core: this.core,
        signal: scope.signal,
        closeTimeoutMs: 5000,
        maxWaiters: 1,
      });
      let ast = '',
        plan = '';
      for await (const part of session.client.executeQuery(
        {
          sessionId: session.id,
          execMode: ExecMode.EXPLAIN,
          statsMode: StatsMode.FULL,
          query: { case: 'queryContent', value: { syntax: 1, text } },
        },
        { signal: scope.signal },
      )) {
        checkStatus(part);
        if (part.execStats?.queryAst) ast = part.execStats.queryAst;
        if (part.execStats?.queryPlan) plan = part.execStats.queryPlan;
      }
      return { ast, plan };
    } finally {
      clearTimeout(timeout);
      await session?.close();
    }
  }
  async databaseName(): Promise<string> {
    return this.core.database;
  }
  async tableExists(name: string): Promise<boolean> {
    return this.native.tableExists(name);
  }
  executeYql(request: YdbQueryRequest): Promise<YdbQueryResult> {
    return (this.transactions.getStore() ?? this.native).executeYql(request);
  }
  async query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ rows: Row[] }> {
    if (params?.length)
      throw new Error(
        'Control YQL requires explicitly typed named parameters; use executeYql().',
      );
    const result = await this.executeYql({ text: sql });
    return { rows: result.resultSets.flatMap((set) => set.rows) as Row[] };
  }
  async executeDdl(sql: string): Promise<void> {
    if (this.transactions.getStore())
      throw new Error('YDB DDL cannot execute inside a transaction.');
    await this.native.executeYql({
      text: sql,
      transactionMode: 'implicit',
      retry: false,
    });
  }
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore())
      throw new Error('Nested YDB control transactions are unsupported.');
    const connection = await this.native.acquireConnection();
    let tx: YdbTransaction | undefined;
    try {
      tx = await connection.beginTransaction();
      const current = tx;
      return await this.transactions.run(current, async () => {
        const value = await fn();
        await current.commit();
        return value;
      });
    } catch (error) {
      await tx?.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (connection.reusable) await connection.release();
      else {
        try {
          await connection.destroy();
        } catch {
          connection.abandon();
        }
      }
    }
  }
}

export function requireYdbControlDriver(value: unknown): YdbControlDriver {
  if (!(value instanceof YdbControlDriver))
    throw new Error('Expected the native YDB control driver.');
  return value;
}

export const ydbControlDriverDescriptor: ControlDriverDescriptor<
  'sql',
  'ydb',
  YdbControlDriver,
  YdbBinding | string
> = {
  kind: 'driver',
  id: 'ydb',
  familyId: 'sql',
  targetId: 'ydb',
  version: '0.0.1',
  async create(connection, options) {
    const driver = new YdbDriver({
      ...(options?.connectTimeoutMs
        ? { acquireTimeoutMs: options.connectTimeoutMs }
        : {}),
    });
    try {
      await driver.connect(
        typeof connection === 'string' ? { url: connection } : connection,
      );
      return new YdbControlDriver(driver);
    } catch (error) {
      await driver.close().catch(() => undefined);
      throw error;
    }
  },
};
