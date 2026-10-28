export interface Scope {
  readonly signal: AbortSignal;
  /** Abort this scope locally, for example when a consumer stops a stream early. */
  abort(reason?: unknown): void;
  /** Link one more parent after construction; the link is removed by dispose(). */
  follow(parent: AbortSignal | undefined): void;
  dispose(): void;
}

/** Disposable deadline and signal links; never retain completed requests until timeout. */
export function deadline(
  timeoutMs?: number,
  ...parents: (AbortSignal | undefined)[]
): Scope {
  if (timeoutMs !== undefined && !(Number.isFinite(timeoutMs) && timeoutMs > 0))
    throw new TypeError('YDB timeoutMs must be positive');
  const controller = new AbortController();
  const listeners: (() => void)[] = [];
  const follow = (parent: AbortSignal | undefined): void => {
    if (!parent || controller.signal.aborted) return;
    if (parent.aborted) {
      controller.abort(parent.reason);
      return;
    }
    const abort = () => controller.abort(parent.reason);
    parent.addEventListener('abort', abort, { once: true });
    listeners.push(() => parent.removeEventListener('abort', abort));
  };
  for (const parent of parents) follow(parent);
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () => controller.abort(new Error('YDB deadline exceeded')),
          Math.ceil(timeoutMs),
        );
  timer?.unref();
  return {
    signal: controller.signal,
    abort: (reason) => controller.abort(reason),
    follow,
    dispose() {
      clearTimeout(timer);
      for (const remove of listeners) remove();
      listeners.length = 0;
    },
  };
}

/** Abortable pause used between retry attempts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
