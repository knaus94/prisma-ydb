import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import {
  deadSessionStatuses,
  GRPC_RESOURCE_EXHAUSTED,
  YdbQueryError,
  YdbTransportError,
} from './errors.js';
import type { YdbRetryOptions } from './types.js';

export const retryDefaults: Required<YdbRetryOptions> = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 10,
  maxDelayMs: 1_000,
  overloadedBaseDelayMs: 200,
  overloadedMaxDelayMs: 5_000,
});

/** Shared full-jitter backoff for statements and whole transaction callbacks. */
export function retryDelayMs(
  error: unknown,
  attempt: number,
  options: Required<YdbRetryOptions>,
): number {
  const status = error instanceof YdbQueryError ? error.status : undefined;
  // A dead session is replaced by a fresh one; nothing to wait for.
  if (status !== undefined && deadSessionStatuses.has(status)) return 0;
  const overloaded =
    status === Status.OVERLOADED ||
    (error instanceof YdbTransportError &&
      error.grpcCode === GRPC_RESOURCE_EXHAUSTED);
  const base = overloaded ? options.overloadedBaseDelayMs : options.baseDelayMs;
  const cap = overloaded ? options.overloadedMaxDelayMs : options.maxDelayMs;
  return Math.floor(
    Math.random() * Math.min(cap, base * 2 ** Math.min(attempt - 1, 30)),
  );
}
