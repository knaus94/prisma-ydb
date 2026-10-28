import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getEventListeners } from 'node:events';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { YdbQueryError, YdbTransportError } from '../../dist/driver/errors.js';
import { withRetry } from '../../dist/driver/retry.js';

const immediate = { budgetMs: 1000, baseDelayMs: 0, maxDelayMs: 0 };

test('retry counts total attempts, reports backoff and rethrows the last failure', async () => {
  const failure = new YdbQueryError(Status.ABORTED, 'query');
  let attempts = 0;
  const events: number[] = [];
  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        throw failure;
      },
      {
        ...immediate,
        maxAttempts: 3,
        onRetry: ({ attempt, delayMs }) => {
          events.push(attempt);
          assert.equal(delayMs, 0);
        },
      },
    ),
    (error) => error === failure,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(events, [2, 3]);
  attempts = 0;
  assert.equal(
    await withRetry(() => {
      if (++attempts < 2) throw failure;
      return 42;
    }, immediate),
    42,
  );
});

test('idempotency permits transport replay but never uncertain or application failures', async () => {
  for (const [failure, idempotent, expected] of [
    [new YdbTransportError('query'), false, 1],
    [new YdbTransportError('query'), true, 2],
    [new YdbTransportError('commit', true), true, 1],
    [new Error('application'), true, 1],
  ] as const) {
    let attempts = 0;
    await assert.rejects(
      withRetry(
        () => {
          attempts++;
          throw failure;
        },
        { ...immediate, idempotent, maxAttempts: 2 },
      ),
      (error) => error === failure,
    );
    assert.equal(attempts, expected);
  }
});

test('the time budget bounds in-flight work and zero-delay retry loops', async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    withRetry(
      (current) => {
        signal = current;
        return new Promise<never>(() => undefined);
      },
      { budgetMs: 20 },
    ),
    { name: 'TimeoutError' },
  );
  assert.equal(signal?.aborted, true);
  const failure = new YdbQueryError(Status.ABORTED, 'query');
  let attempts = 0;
  await assert.rejects(
    withRetry(
      () => {
        attempts++;
        throw failure;
      },
      {
        ...immediate,
        budgetMs: 10,
        maxAttempts: Number.MAX_SAFE_INTEGER,
      },
    ),
    (error) => error === failure,
  );
  assert.ok(attempts > 0 && attempts < Number.MAX_SAFE_INTEGER);
});

test('abort interrupts backoff, preserves the failure, and removes parent listeners', async (context) => {
  context.mock.method(Math, 'random', () => 0.5);
  const parent = new AbortController();
  const failure = new YdbQueryError(Status.ABORTED, 'query');
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await assert.rejects(
      withRetry(
        () => {
          attempts++;
          throw failure;
        },
        {
          budgetMs: 1000,
          signal: parent.signal,
          baseDelayMs: 100,
          onRetry: () => {
            timer = setTimeout(() => parent.abort(new Error('cancel')), 0);
          },
        },
      ),
      (error) => error === failure,
    );
    assert.ok(attempts < 5);
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  } finally {
    clearTimeout(timer);
  }
  const preAborted = new AbortController();
  const reason = new Error('cancel before start');
  preAborted.abort(reason);
  await assert.rejects(
    withRetry(() => assert.fail('must not run'), {
      ...immediate,
      signal: preAborted.signal,
    }),
    (error) => error === reason,
  );
});
