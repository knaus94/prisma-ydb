import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { QueryServiceDefinition } from '@ydbjs/api/query';
import type { Driver } from '@ydbjs/core';
import { deadline } from './abort.js';
import { checkStatus, normalizeError } from './errors.js';
import { Semaphore } from './semaphore.js';

export interface SessionOptions {
  readonly core: Driver;
  readonly signal: AbortSignal;
  /** Bound for the DeleteSession RPC when cleanup is needed. */
  readonly closeTimeoutMs: number;
  /** Queue bound for operations waiting on this session's serial lock. */
  readonly maxWaiters: number;
}

/** One native QueryService session: node-pinned client, attachment watch, serial lock. */
export class Session {
  readonly createdAt = Date.now();
  idleSince = Date.now();
  readonly life = new AbortController();
  readonly attach = new AbortController();
  readonly client;
  /** YDB runs one operation per session at a time; leases share this lock. */
  readonly serial: Semaphore;
  readonly #closeTimeoutMs: number;
  #closed = false;

  private constructor(
    options: SessionOptions,
    readonly id: string,
    readonly nodeId: bigint,
  ) {
    // SDK 6.3 uses preferred-node routing. The explicit session ID is authoritative;
    // a failed/lost session is surfaced and is never silently replayed on another node.
    this.client = options.core.createClient(QueryServiceDefinition, nodeId);
    this.serial = new Semaphore(1, options.maxWaiters);
    this.#closeTimeoutMs = options.closeTimeoutMs;
  }

  static async open(options: SessionOptions): Promise<Session> {
    const { core, signal } = options;
    const bootstrap = core.createClient(QueryServiceDefinition);
    let session: Session | undefined;
    try {
      const response = await bootstrap.createSession({}, { signal });
      checkStatus(response);
      session = new Session(options, response.sessionId, response.nodeId);
      const opening = session;
      // The acquisition deadline must not cancel the long-lived attachment after it succeeds.
      const forward = () => opening.attach.abort(signal.reason);
      signal.addEventListener('abort', forward, { once: true });
      try {
        const iterator = session.client
          .attachSession(
            { sessionId: session.id },
            { signal: session.attach.signal },
          )
          [Symbol.asyncIterator]();
        signal.throwIfAborted();
        const first = await iterator.next();
        if (first.done)
          throw new Error('YDB session attach ended before acknowledgement');
        checkStatus(first.value);
        void session.#watch(iterator);
      } finally {
        signal.removeEventListener('abort', forward);
      }
      return session;
    } catch (error) {
      if (session) await session.close().catch(() => session?.dispose());
      throw normalizeError(error, 'create session');
    }
  }

  get alive(): boolean {
    return !this.life.signal.aborted && !this.#closed;
  }

  async #watch(
    iterator: AsyncIterator<{
      status: Status;
      issues: Parameters<typeof checkStatus>[0]['issues'];
    }>,
  ): Promise<void> {
    try {
      for (;;) {
        const next = await iterator.next();
        if (next.done) break;
        checkStatus(next.value);
      }
    } catch {
      // Failure is propagated through the shared lifecycle signal, never an unhandled promise.
    } finally {
      this.life.abort(new Error('YDB session attachment ended'));
      try {
        await iterator.return?.();
      } catch {
        /* stream already failed */
      }
    }
  }

  /** Delete the session on the server; a dead session is only disposed locally. */
  async close(): Promise<void> {
    if (!this.alive) {
      this.dispose();
      return;
    }
    const scope = deadline(this.#closeTimeoutMs);
    try {
      const response = await this.client.deleteSession(
        { sessionId: this.id },
        { signal: scope.signal },
      );
      if (!closedStatuses.has(response.status)) checkStatus(response);
    } catch (error) {
      throw normalizeError(error, 'delete session');
    } finally {
      scope.dispose();
      this.dispose();
    }
  }

  dispose(): void {
    this.#closed = true;
    this.attach.abort();
    this.life.abort();
  }
}

const closedStatuses = new Set([
  Status.SUCCESS,
  Status.BAD_SESSION,
  Status.SESSION_EXPIRED,
  Status.NOT_FOUND,
]);
