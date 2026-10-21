import { YdbQueryError } from './errors.js';
import type { Options } from './options.js';
import type { YdbDriverEvent, YdbPoolStats } from './types.js';

/** Timing/status observer hook; it never sees SQL, parameters or issue text. */
export interface EventSink {
  readonly config: Options;
  readonly stats: YdbPoolStats;
}

export function emit(
  sink: EventSink,
  operation: YdbDriverEvent['operation'],
  started: number,
  error?: unknown,
  attempt?: number,
): void {
  const observer = sink.config.onEvent;
  if (!observer) return;
  try {
    observer({
      operation,
      pool: sink.stats,
      durationMs: performance.now() - started,
      success: error === undefined,
      status: error instanceof YdbQueryError ? error.status : undefined,
      ...(attempt !== undefined ? { attempt } : {}),
    });
  } catch {
    /* Observability must never change database execution semantics. */
  }
}
