import type { QueryStats } from '@ydbjs/api/query';
import type { TransactionObservation } from '../driver/connection.js';
import type { YdbTransactionEventDetails } from '../driver/types.js';

export interface TransactionControl {
  readonly signal: AbortSignal;
  readonly deadline: number;
  failed(error: unknown): void;
  check(): void;
  wait<T>(work: Promise<T>): Promise<T>;
  dispose(): void;
}

/** Only allocated when a caller requests cancellation or an overall budget. */
export function transactionControl(
  signal?: AbortSignal,
  budgetMs?: number,
): TransactionControl {
  const controller = new AbortController();
  const deadline =
    budgetMs === undefined ? Infinity : performance.now() + budgetMs;
  let lastError: unknown;
  let failed = false;
  const expire = () => {
    const error = new DOMException(
      'Transaction budget exhausted',
      'TimeoutError',
    );
    if (failed)
      Object.defineProperty(error, 'cause', {
        value: lastError,
        configurable: true,
      });
    controller.abort(error);
  };
  const cancel = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer =
    budgetMs === undefined ? undefined : setTimeout(expire, budgetMs);
  timer?.unref();
  return {
    signal: controller.signal,
    deadline,
    failed(error: unknown) {
      const reason = controller.signal.reason;
      // Cancellation itself is not an attempt failure (nor its own cause).
      if (controller.signal.aborted && error === reason) return;
      lastError = error;
      failed = true;
      if (
        reason instanceof DOMException &&
        reason.name === 'TimeoutError' &&
        !('cause' in reason)
      )
        Object.defineProperty(reason, 'cause', {
          value: error,
          configurable: true,
        });
    },
    check() {
      if (performance.now() >= deadline) expire();
      controller.signal.throwIfAborted();
    },
    /** Shared connection/marker initialization continues for other callers. */
    async wait<T>(work: Promise<T>): Promise<T> {
      if (controller.signal.aborted) void work.catch(() => undefined);
      controller.signal.throwIfAborted();
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', abort, { once: true });
      });
      try {
        return await Promise.race([work, aborted]);
      } finally {
        controller.signal.removeEventListener('abort', abort);
      }
    },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    },
  };
}

/** Final-attempt counters; no instance or statement callback without an event sink. */
export function transactionObservation(stats: boolean, signal?: AbortSignal) {
  let statements = 0;
  let phases = 0;
  let affectedShards = 0;
  let maxAffectedShards = 0;
  let cpuTimeUs = 0n;
  let durationUs = 0n;
  type Table = NonNullable<
    YdbTransactionEventDetails['stats']
  >['tables'][number];
  const tables = stats ? new Map<string, Table>() : undefined;
  const observation: TransactionObservation = {
    signal,
    stats: stats ? 'basic' : undefined,
    onStatement(value?: QueryStats) {
      statements++;
      if (!tables || !value) return;
      cpuTimeUs += value.totalCpuTimeUs;
      durationUs += value.totalDurationUs;
      for (const phase of value.queryPhases) {
        phases++;
        const shards = Number(phase.affectedShards);
        affectedShards += shards;
        maxAffectedShards = Math.max(maxAffectedShards, shards);
        for (const access of phase.tableAccess) {
          let table = tables.get(access.name);
          if (!table) {
            table = {
              name: access.name,
              partitionsCount: 0,
              readRows: 0n,
              readBytes: 0n,
              updateRows: 0n,
              deleteRows: 0n,
            };
            tables.set(access.name, table);
          }
          table.partitionsCount = Math.max(
            table.partitionsCount,
            Number(access.partitionsCount),
          );
          table.readRows += access.reads?.rows ?? 0n;
          table.readBytes += access.reads?.bytes ?? 0n;
          table.updateRows += access.updates?.rows ?? 0n;
          table.deleteRows += access.deletes?.rows ?? 0n;
        }
      }
    },
  };
  return {
    observation,
    details() {
      return {
        statements,
        ...(tables
          ? {
              stats: {
                phases,
                affectedShards,
                maxAffectedShards,
                cpuTimeUs,
                durationUs,
                tables: [...tables.values()],
              },
            }
          : {}),
      };
    },
  };
}
