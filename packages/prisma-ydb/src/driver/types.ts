import type { SqlExecuteRequest } from '@prisma/orm-family-sql/relational-core/ast';
import type { QueryStats } from '@ydbjs/api/query';
import type { Column, Type, Value as WireValue } from '@ydbjs/api/value';
import type { DriverOptions } from '@ydbjs/core';
import type { Value } from '@ydbjs/value';

export interface YdbBinding {
  readonly url: string;
  readonly driverOptions?: DriverOptions;
}

export interface YdbDriverOptions {
  readonly maxSessions?: number;
  readonly minSessions?: number;
  /**
   * Cap on sessions held through acquireConnection(): interactive transactions,
   * Prisma mutation graphs and explicit connections. Defaults to maxSessions;
   * a lower value keeps the remainder free for driver-owned autocommit statements.
   */
  readonly maxTransactionSessions?: number;
  readonly sessionMaxIdleMs?: number;
  readonly sessionMaxAgeMs?: number;
  readonly sessionCloseTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  readonly readTransactionMode?: 'snapshotReadOnly' | 'serializable';
  readonly statsMode?: 'none' | 'basic';
  readonly retry?: false | YdbRetryOptions;
  readonly maxWaiters?: number;
  readonly acquireTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly transactionTimeoutMs?: number;
  readonly maxResultRows?: number;
  readonly maxResultBytes?: number;
  /** Opt-in diagnostics. Server issue text in Error.cause may contain SQL or data. */
  readonly includeServerIssues?: boolean;
  /** Receives timing/status only. SQL, parameters, credentials and issues are excluded. */
  readonly onEvent?: (event: YdbDriverEvent) => void;
}

export interface YdbDriverEvent {
  readonly operation:
    | 'connect'
    | 'acquire'
    | 'session-create'
    | 'query'
    | 'begin'
    | 'commit'
    | 'rollback'
    | 'destroy'
    | 'retry'
    | 'bulk-upsert';
  readonly pool: YdbPoolStats;
  readonly attempt?: number;
  readonly durationMs: number;
  readonly success: boolean;
  readonly status?: number;
}

export type YdbParameter =
  | Value
  | { readonly type: Type; readonly value: WireValue };

export interface YdbQueryRequest {
  readonly text: string;
  readonly parameters?: Readonly<Record<string, YdbParameter>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /**
   * Omitted: compiler-tagged SELECTs use the driver's `readTransactionMode`, everything
   * else runs in one serializable transaction. DDL requires explicit implicit mode.
   */
  readonly transactionMode?: 'serializable' | 'snapshotReadOnly' | 'implicit';
  /** Allows eligible retries for replay-safe requests; never overrides outcomeUnknown. */
  readonly idempotent?: boolean;
  /** `false` disables driver retries for this request; `true` enables them for implicit mode. */
  readonly retry?: boolean;
  readonly stats?: 'none' | 'basic';
  /** Wire mode preserves protobuf values for YQL types outside the decoded scalar mapping. */
  readonly valueMode?: 'decoded' | 'wire';
  /** Count RETURNING rows. Native YDB execution stats also count index writes. */
  readonly affectedRows?: 'returning';
  /**
   * Inside an interactive transaction: commit together with this statement,
   * saving the separate CommitTransaction round trip. The transaction accepts
   * no further statements; a later commit() is a no-op and rollback() fails.
   */
  readonly commit?: boolean;
}

export interface YdbSqlExecuteRequest extends SqlExecuteRequest {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export type YdbTransactionMode = 'serializable' | 'snapshotReadOnly';

export interface YdbBeginTransactionOptions {
  /** Snapshot read-only transactions never conflict with writers; writes in them are rejected by the server. */
  readonly mode?: YdbTransactionMode;
}

export interface YdbBulkUpsertRequest {
  /** Database-relative table path. */
  readonly table: string;
  /** A List<Struct<...>> value; every struct carries the full primary key. */
  readonly rows: YdbParameter;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** BulkUpsert is idempotent; `false` disables the driver's bounded retries. */
  readonly retry?: boolean;
}

export interface YdbQueryPart {
  readonly resultSetIndex: number;
  readonly columns: readonly Column[];
  readonly rows: readonly Record<string, unknown>[];
  readonly stats?: QueryStats;
}

export interface YdbResultSet {
  readonly columns: readonly Column[];
  readonly rows: Record<string, unknown>[];
}

export interface YdbQueryResult {
  readonly resultSets: YdbResultSet[];
  /** Exact RETURNING count when requested, otherwise zero (not an index-write estimate). */
  readonly affectedRows: number;
  readonly stats?: QueryStats;
}

export interface YdbRetryOptions {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly overloadedBaseDelayMs?: number;
  readonly overloadedMaxDelayMs?: number;
}

export interface YdbPoolStats {
  readonly maxSessions: number;
  readonly idle: number;
  readonly leased: number;
  /** Leases obtained through acquireConnection(), bounded by maxTransactionSessions. */
  readonly held: number;
  readonly creating: number;
  readonly waiters: number;
  readonly closing: number;
}

export interface YdbHealth {
  readonly ready: boolean;
  readonly state: 'unbound' | 'connecting' | 'connected' | 'closing' | 'closed';
  readonly latencyMs?: number;
  readonly pool: YdbPoolStats;
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly status?: number;
  };
}
