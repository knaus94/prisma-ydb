import assert from 'node:assert/strict';
import { test } from 'node:test';
import { create } from '@bufbuild/protobuf';
import {
  IssueMessageSchema,
  StatusIds_StatusCode as Status,
} from '@ydbjs/api/operation';
import { YDBError } from '@ydbjs/error';
import {
  classifyYdbError,
  normalizeError,
  YdbQueryError,
  YdbTransportError,
} from '../../dist/driver/errors.js';

function queryError(message: string, issueCode = 0) {
  return new YDBError(Status.PRECONDITION_FAILED, [
    create(IssueMessageSchema, { message, issueCode, severity: 1 }),
  ]);
}

test('classification follows causes and preserves the primary aggregate failure', () => {
  const conflict = new YdbQueryError(Status.ABORTED, 'query');
  const wrapped = new Error('wrapper', {
    cause: new AggregateError([
      conflict,
      new YdbTransportError('rollback', true),
    ]),
  });
  assert.equal(classifyYdbError(wrapped).kind, 'conflict');
  assert.equal(classifyYdbError(wrapped).retryable, true);
  const primary = new Error('application failure');
  assert.equal(
    classifyYdbError(new AggregateError([primary, conflict])).kind,
    'unknown',
  );
  primary.cause = primary;
  assert.equal(classifyYdbError(primary).retryable, false);
});

test('Ensure exposes only the authored message from the observed 26.2 envelope', () => {
  const raw = queryError(
    'Terminate was called, reason(52): <main>:1:8: Condition violated:\n\nline one\nline two\n\n\n',
  );
  const normalized = normalizeError(raw, 'query');
  assert.ok(normalized instanceof YdbQueryError);
  assert.deepEqual(normalized.ensure, { message: 'line one\nline two' });
  assert.equal(normalized.cause, undefined);
  assert.deepEqual(normalized.issueCodes, []);
  assert.equal(normalized.message.includes('line one'), false);
  assert.equal(classifyYdbError(raw).kind, 'ensure');
  assert.equal(classifyYdbError(raw).retryableIfIdempotent, false);
  assert.equal(normalizeError(raw, 'query', false, true).cause, raw);
  const unrelated = classifyYdbError(queryError('private server diagnostics'));
  assert.equal(unrelated.kind, 'query');
  assert.equal(unrelated.ensure, undefined);
  const empty = classifyYdbError(
    queryError(
      'Terminate was called, reason(30): <main>:1:8: Condition violated\n',
    ),
  );
  assert.equal(empty.ensure, undefined);
});

test('unique and referential guards remain distinct from general precondition failures', () => {
  const unique = classifyYdbError(
    queryError('Conflict with existing key. secret key', 2012),
  );
  assert.equal(unique.kind, 'unique');
  assert.equal(unique.uniqueViolation, true);
  assert.equal(
    classifyYdbError(queryError('different constraint', 2012)).uniqueViolation,
    false,
  );
  assert.equal(
    classifyYdbError(queryError('YDB.REFERENTIAL_ACTION')).kind,
    'referential',
  );
});

test('classification distinguishes idempotent retries and uncertain outcomes', () => {
  const timeout = classifyYdbError(new YdbQueryError(Status.TIMEOUT, 'query'));
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.retryable, false);
  assert.equal(timeout.retryableIfIdempotent, true);
  for (const error of [
    new YdbQueryError(Status.UNAVAILABLE, 'commit', true),
    new YdbTransportError('commit', true),
  ]) {
    const classification = classifyYdbError(error);
    assert.equal(classification.outcomeUnknown, true);
    assert.equal(classification.retryableIfIdempotent, false);
  }
  assert.equal(
    classifyYdbError(new YdbTransportError('query', false, 1)).kind,
    'cancelled',
  );
});
