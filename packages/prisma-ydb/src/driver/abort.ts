export interface Scope {
  readonly signal: AbortSignal;
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
  for (const parent of parents) {
    if (!parent) continue;
    const abort = () => controller.abort(parent.reason);
    if (parent.aborted) abort();
    else {
      parent.addEventListener('abort', abort, { once: true });
      listeners.push(() => parent.removeEventListener('abort', abort));
    }
  }
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
    dispose() {
      clearTimeout(timer);
      for (const remove of listeners) remove();
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
