import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { YDBError } from '@ydbjs/error';
import { sleep } from './abort.js';
import {
  classifyYdbError,
  deadSessionStatuses,
  GRPC_RESOURCE_EXHAUSTED,
  normalizeError,
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
  if (
    !(error instanceof YdbQueryError) &&
    !(error instanceof YdbTransportError)
  ) {
    const seen = new Set<unknown>();
    while (error instanceof Error && !seen.has(error)) {
      seen.add(error);
      if (error instanceof YDBError) {
        error = normalizeError(error, 'query');
        break;
      }
      if (error instanceof YdbQueryError || error instanceof YdbTransportError)
        break;
      error = error instanceof AggregateError ? error.errors[0] : error.cause;
    }
  }
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

export interface WithRetryOptions extends YdbRetryOptions {
  readonly budgetMs: number;
  readonly signal?: AbortSignal;
  readonly idempotent?: boolean;
  readonly retry?: YdbRetryOptions;
  /** Called before backoff; attempt is the next attempt, counting from one. */
  readonly onRetry?: (event: {
    error: unknown;
    attempt: number;
    delayMs: number;
  }) => void;
}

/** Bounded retries for autocommit work; forward the supplied signal to the RPC. */
export async function withRetry<T>(
  fn: (signal: AbortSignal) => T | PromiseLike<T>,
  options: WithRetryOptions,
): Promise<T> {
  const retry = { ...retryDefaults, ...options.retry, ...options };
  if (
    !Number.isFinite(options.budgetMs) ||
    options.budgetMs <= 0 ||
    options.budgetMs > 2_147_483_647
  )
    throw new TypeError(
      'Retry budgetMs must be positive and at most 2147483647',
    );
  if (!Number.isSafeInteger(retry.maxAttempts) || retry.maxAttempts < 1)
    throw new TypeError('Retry maxAttempts must be a positive integer');
  for (const key of [
    'baseDelayMs',
    'maxDelayMs',
    'overloadedBaseDelayMs',
    'overloadedMaxDelayMs',
  ] as const)
    if (
      !Number.isFinite(retry[key]) ||
      retry[key] < 0 ||
      retry[key] > 2_147_483_647
    )
      throw new TypeError(`Retry ${key} must be between 0 and 2147483647`);
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = performance.now() + options.budgetMs;
  let lastError: unknown;
  let failed = false;
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(
    () =>
      controller.abort(
        new DOMException('Retry budget exhausted', 'TimeoutError'),
      ),
    options.budgetMs,
  );
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(failed ? lastError : signal.reason);
    signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    return await Promise.race([
      (async () => {
        for (let attempt = 1; ; attempt++) {
          if (performance.now() >= deadline)
            controller.abort(
              new DOMException('Retry budget exhausted', 'TimeoutError'),
            );
          if (signal.aborted && failed) throw lastError;
          signal.throwIfAborted();
          try {
            return await fn(signal);
          } catch (error) {
            lastError = error;
            failed = true;
            const classification = classifyYdbError(error);
            if (
              signal.aborted ||
              attempt >= retry.maxAttempts ||
              classification.outcomeUnknown ||
              !(
                classification.retryable ||
                (options.idempotent && classification.retryableIfIdempotent)
              )
            )
              throw error;
            const delayMs = retryDelayMs(error, attempt, retry);
            if (performance.now() + delayMs >= deadline) throw error;
            options.onRetry?.({ error, attempt: attempt + 1, delayMs });
            if (delayMs > 0) {
              try {
                await sleep(delayMs, signal);
              } catch {
                throw error;
              }
            }
          }
        }
      })(),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    signal.removeEventListener('abort', rejectAbort);
  }
}
