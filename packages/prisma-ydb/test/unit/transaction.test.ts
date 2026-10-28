import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { readFile } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { ydb, ydbTransactionRetryPolicy } from 'prisma-ydb/runtime';
import { YdbDriver, YdbQueryError, YdbTransportError } from 'prisma-ydb/driver';

const contractJson = JSON.parse(
  await readFile(
    new URL(
      '../../../../examples/basic/prisma/migrations/snapshots/edb823ca65f272c0f5af57fea6d9fc044a6ce25b440fbf6d696a5a6af767aa9e/contract.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

function fakeClient(context: TestContext) {
  let acquired = 0;
  let rollbacks = 0;
  context.mock.method(YdbDriver.prototype, 'connect', async () => undefined);
  context.mock.method(YdbDriver.prototype, 'close', async () => undefined);
  context.mock.method(YdbDriver.prototype, 'acquireConnection', async () => {
    acquired++;
    return {
      reusable: true,
      async beginTransaction() {
        return {
          committed: false,
          async commit() {
            this.committed = true;
          },
          async rollback() {
            rollbacks++;
          },
        };
      },
      async release() {},
    };
  });
  const db = ydb({
    contractJson,
    url: 'grpc://127.0.0.1:1/unit',
    verifyMarker: false,
  });
  context.after(() => db.close());
  return { db, acquired: () => acquired, rollbacks: () => rollbacks };
}

test('transaction policy rejects unknown outcomes and uses the primary classification', () => {
  const policy = ydbTransactionRetryPolicy();
  const unique = new YdbQueryError(
    Status.PRECONDITION_FAILED,
    'query',
    false,
    [],
    undefined,
    true,
  );
  assert.equal(policy.isRetryable(unique), true);
  assert.equal(
    ydbTransactionRetryPolicy({ uniqueViolation: false }).isRetryable(unique),
    false,
  );
  const conflict = new YdbQueryError(Status.ABORTED, 'query');
  assert.equal(
    policy.isRetryable(
      new Error('wrapper', {
        cause: new AggregateError([conflict, new Error('rollback')]),
      }),
    ),
    true,
  );
  for (const error of [
    new YdbQueryError(Status.UNAVAILABLE, 'commit', true),
    new YdbTransportError('commit', true),
    new YdbTransportError('query', false, 1),
    new YdbQueryError(Status.PRECONDITION_FAILED, 'query'),
    new Error('application'),
    new AggregateError([new Error('primary'), conflict]),
  ])
    assert.equal(policy.isRetryable(error), false);
});

test('transaction policy uses overload/conflict bounds and merges delay overrides once', (context) => {
  context.mock.method(Math, 'random', () => 0.5);
  const conflict = new YdbQueryError(Status.ABORTED, 'query');
  const overload = new YdbQueryError(Status.OVERLOADED, 'query');
  const policy = ydbTransactionRetryPolicy();
  assert.equal(policy.delayMs(conflict, 1), 5);
  assert.equal(policy.delayMs(overload, 1), 100);
  assert.equal(policy.delayMs(conflict, 30), 500);
  assert.equal(policy.delayMs(overload, 30), 2500);
  assert.equal(
    ydbTransactionRetryPolicy({
      retry: { baseDelayMs: 4, maxDelayMs: 6 },
    }).delayMs(conflict, 2),
    3,
  );
});

test('transaction retries report next attempts and onRetry exceptions stop replay', async (context) => {
  const { db, acquired, rollbacks } = fakeClient(context);
  const failure = new YdbQueryError(Status.ABORTED, 'query');
  const policy = { isRetryable: () => true, delayMs: () => 0 };
  let attempts = 0;
  const next: number[] = [];
  assert.equal(
    await db.transaction(
      async () => {
        if (++attempts < 3) throw failure;
        return 42;
      },
      {
        retry: { maxAttempts: 3, policy },
        onRetry: (event) => {
          next.push(event.attempt);
          assert.equal(event.error, failure);
          assert.equal(event.classification.kind, 'conflict');
          assert.equal(event.delayMs, 0);
        },
      },
    ),
    42,
  );
  assert.deepEqual(next, [2, 3]);
  assert.equal(acquired(), 3);
  assert.equal(rollbacks(), 2);
  const reason = new Error('observer failure');
  await assert.rejects(
    db.transaction(
      async () => {
        throw failure;
      },
      {
        retry: { policy },
        onRetry: () => {
          throw reason;
        },
      },
    ),
    (error) => error === reason,
  );
  assert.equal(acquired(), 4);
});

test('transaction signal interrupts attempts/backoff and removes caller listeners', async (context) => {
  const { db, acquired, rollbacks } = fakeClient(context);
  const reason = new Error('caller cancelled');
  const preAborted = AbortSignal.abort(reason);
  await assert.rejects(
    db.transaction(async () => assert.fail('must not run'), {
      signal: preAborted,
    }),
    (error) => error === reason,
  );
  assert.equal(acquired(), 0);
  const parent = new AbortController();
  await assert.rejects(
    db.transaction(
      async (tx) => {
        parent.abort(reason);
        assert.equal(tx.signal.aborted, true);
        return new Promise<never>(() => undefined);
      },
      { signal: parent.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(rollbacks(), 1);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  const backoff = new AbortController();
  const failure = new YdbQueryError(Status.ABORTED, 'query');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      db.transaction(
        async () => {
          throw failure;
        },
        {
          signal: backoff.signal,
          retry: { policy: { isRetryable: () => true, delayMs: () => 500 } },
          onRetry: () => {
            timer = setTimeout(() => backoff.abort(reason), 1);
          },
        },
      ),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
  assert.equal(acquired(), 2);
  assert.equal(getEventListeners(backoff.signal, 'abort').length, 0);
  const successful = new AbortController();
  await db.transaction(async () => 42, { signal: successful.signal });
  assert.equal(getEventListeners(successful.signal, 'abort').length, 0);
  context.mock.method(
    YdbDriver.prototype,
    'acquireConnection',
    async (signal: AbortSignal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      ),
  );
  const acquiring = new AbortController();
  const pending = db.transaction(async () => assert.fail('must not run'), {
    signal: acquiring.signal,
  });
  const cancelAcquire = setTimeout(() => acquiring.abort(reason), 1);
  try {
    await assert.rejects(pending, (error) => error === reason);
  } finally {
    clearTimeout(cancelAcquire);
  }
  assert.equal(getEventListeners(acquiring.signal, 'abort').length, 0);
});

test('transaction budget aborts an attempt with TimeoutError and forbids backoff beyond budget', async (context) => {
  const { db, acquired, rollbacks } = fakeClient(context);
  // Production deadline timers are unref'ed; keep this offline hung callback alive.
  const keepAlive = setTimeout(() => undefined, 1000);
  let signal: AbortSignal | undefined;
  try {
    await assert.rejects(
      db.transaction(
        async (tx) => {
          signal = tx.signal;
          return new Promise<never>(() => undefined);
        },
        { retry: { budgetMs: 20 } },
      ),
      (error) => {
        assert.ok(error instanceof DOMException);
        assert.equal(error.name, 'TimeoutError');
        assert.equal('cause' in error, false);
        return true;
      },
    );
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(signal?.aborted, true);
  assert.equal(rollbacks(), 1);
  const failure = new YdbQueryError(Status.ABORTED, 'query');
  await assert.rejects(
    db.transaction(
      async () => {
        throw failure;
      },
      {
        retry: {
          budgetMs: 100,
          policy: { isRetryable: () => true, delayMs: () => 1000 },
        },
        onRetry: () => assert.fail('backoff cannot fit'),
      },
    ),
    (error) => error === failure,
  );
  assert.equal(acquired(), 2);
  await assert.rejects(
    db.transaction(
      async () => {
        throw failure;
      },
      {
        retry: {
          budgetMs: 10,
          policy: { isRetryable: () => true, delayMs: () => 0 },
        },
        onRetry: () => {
          const until = performance.now() + 15;
          while (performance.now() < until) {
            /* Exhaust the budget synchronously. */
          }
        },
      },
    ),
    (error) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, 'TimeoutError');
      assert.equal((error as Error).cause, failure);
      return true;
    },
  );
});
