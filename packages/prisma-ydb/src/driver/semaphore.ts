import { SqlConnectionError } from '@prisma/orm-family-sql/errors';

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
}

/** Bounded FIFO admission; cancelled waiters are removed immediately. */
export class Semaphore {
  #available: number;
  #queue: Waiter[] = [];
  #closed = false;

  constructor(
    size: number,
    private readonly maxWaiters: number,
  ) {
    this.#available = size;
  }

  get waiters(): number {
    return this.#queue.length;
  }

  /** Take a permit only when one is free right now. */
  tryAcquire(): (() => void) | undefined {
    if (this.#closed || this.#available <= 0) return undefined;
    this.#available--;
    return this.#release();
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.#closed)
      return Promise.reject(new SqlConnectionError('YDB driver is closing'));
    const immediate = this.tryAcquire();
    if (immediate) return Promise.resolve(immediate);
    if (this.#queue.length >= this.maxWaiters) {
      return Promise.reject(
        new SqlConnectionError('YDB connection queue is full'),
      );
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) this.#queue.splice(index, 1);
          reject(
            new SqlConnectionError(
              'YDB connection acquisition was cancelled or timed out',
            ),
          );
        },
      };
      this.#queue.push(waiter);
      signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#queue.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.reject(new SqlConnectionError('YDB driver is closing'));
    }
  }

  #release(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.#queue.shift();
      if (waiter) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.resolve(this.#release());
      } else this.#available++;
    };
  }
}
