import {
  SqlConnectionError,
  SqlQueryError,
} from '@prisma/orm-family-sql/errors';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { YDBError } from '@ydbjs/error';
import { runtimeError } from '@prisma/orm-framework/components/runtime';

/** Server issue messages may contain query text/data, so errors expose status only. */
export class YdbQueryError extends SqlQueryError {
  readonly status: number;
  readonly outcomeUnknown: boolean;
  readonly issueCodes: readonly number[];
  readonly uniqueViolation: boolean;
  readonly ensure?: { readonly message: string };

  constructor(
    status: number,
    operation: string,
    outcomeUnknown = false,
    issueCodes: readonly number[] = [],
    cause?: Error,
    uniqueViolation = false,
    ensure?: { readonly message: string },
  ) {
    super(`YDB ${operation} failed: ${Status[status] ?? 'UNKNOWN_STATUS'}`, {
      sqlState: uniqueViolation
        ? '23505'
        : status === Status.ABORTED
          ? '40001'
          : undefined,
      cause,
    });
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
    this.issueCodes = issueCodes;
    this.uniqueViolation = uniqueViolation;
    this.ensure = ensure;
  }
}

/** gRPC RESOURCE_EXHAUSTED: the transport itself asked for backoff. */
export const GRPC_RESOURCE_EXHAUSTED = 8;

export class YdbTransportError extends SqlConnectionError {
  readonly outcomeUnknown: boolean;
  /** gRPC status code when the transport reported one. */
  readonly grpcCode: number | undefined;

  constructor(operation: string, outcomeUnknown = false, grpcCode?: number) {
    super(`YDB ${operation} transport failed or was cancelled`, {
      transient: true,
    });
    this.outcomeUnknown = outcomeUnknown;
    this.grpcCode = grpcCode;
  }
}

const uncertainStatuses = new Set<number>([
  Status.UNDETERMINED,
  Status.TIMEOUT,
  Status.CANCELLED,
  Status.UNAVAILABLE,
  Status.INTERNAL_ERROR,
  Status.SESSION_EXPIRED,
]);

export function normalizeError(
  error: unknown,
  operation: string,
  commit = false,
  includeServerIssues = false,
): Error {
  if (error instanceof YdbQueryError || error instanceof YdbTransportError)
    return error;
  if (error instanceof YDBError) {
    const issueCodes: number[] = [];
    let uniqueViolation = false;
    let referentialViolation = false;
    let ensure: { message: string } | undefined;
    const visit = (issues: readonly unknown[]): void => {
      for (const issue of issues) {
        if (typeof issue !== 'object' || issue === null) continue;
        // Observed on YDB 26.2: retain only Ensure's authored message, never
        // the surrounding server diagnostics, source position or query text.
        if (
          error.code === Status.PRECONDITION_FAILED &&
          !('issueCode' in issue) &&
          'message' in issue &&
          typeof issue.message === 'string'
        ) {
          const match =
            /^Terminate was called, reason\(\d+\): <main>:\d+:\d+: Condition violated:\n\n([\s\S]*)\n\n\n$/.exec(
              issue.message,
            );
          if (match) ensure = { message: match[1]! };
        }
        if ('issueCode' in issue && typeof issue.issueCode === 'number')
          issueCodes.push(issue.issueCode);
        if (
          'message' in issue &&
          typeof issue.message === 'string' &&
          /(?:^|\n)YDB\.REFERENTIAL_ACTION(?:\n|$)/.test(issue.message)
        )
          referentialViolation = true;
        // 2012 is KIKIMR_CONSTRAINT_VIOLATION, which also covers non-unique
        // constraints. Only this observed native duplicate-key leaf is safe to
        // expose as Prisma's unique violation; PRECONDITION_FAILED alone is not.
        // Column tables append the conflicting key as JSON after the same leaf text.
        if (
          'issueCode' in issue &&
          issue.issueCode === 2012 &&
          'message' in issue &&
          typeof issue.message === 'string' &&
          issue.message.startsWith('Conflict with existing key.')
        )
          uniqueViolation = true;
        if ('issues' in issue && Array.isArray(issue.issues))
          visit(issue.issues);
      }
    };
    visit(error.issues);
    if (error.code === Status.PRECONDITION_FAILED && referentialViolation)
      return runtimeError(
        'YDB.REFERENTIAL_ACTION',
        'A YDB relation requires an existing parent or prevents changing a referenced parent',
      );
    return new YdbQueryError(
      error.code,
      operation,
      commit && uncertainStatuses.has(error.code),
      issueCodes,
      includeServerIssues ? error : undefined,
      error.code === Status.PRECONDITION_FAILED && uniqueViolation,
      ensure,
    );
  }
  if (error instanceof SqlConnectionError || error instanceof SqlQueryError)
    return error;
  const grpcCode =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
      ? error.code
      : undefined;
  return new YdbTransportError(operation, commit, grpcCode);
}

/** Control-plane RPCs answer with an Operation envelope instead of a bare status. */
export function checkOperation(
  operation:
    | {
        ready: boolean;
        status: Status;
        issues: ConstructorParameters<typeof YDBError>[1];
      }
    | undefined,
): void {
  if (!operation?.ready || operation.status !== Status.SUCCESS)
    throw new YDBError(
      operation?.status ?? Status.STATUS_CODE_UNSPECIFIED,
      operation?.issues ?? [],
    );
}

export function checkStatus(response: {
  status: Status;
  issues: ConstructorParameters<typeof YDBError>[1];
}): void {
  if (response.status !== Status.SUCCESS)
    throw new YDBError(response.status, response.issues);
}

const retryableStatuses = new Set<number>([
  Status.ABORTED,
  Status.OVERLOADED,
  Status.UNAVAILABLE,
  Status.BAD_SESSION,
  Status.SESSION_BUSY,
]);
const idempotentStatuses = new Set<number>([
  Status.SESSION_EXPIRED,
  Status.UNDETERMINED,
  Status.TIMEOUT,
]);

export function isRetryableYdbError(
  error: unknown,
  idempotent: boolean,
): boolean {
  if (error instanceof YdbTransportError)
    return idempotent && !error.outcomeUnknown;
  return (
    error instanceof YdbQueryError &&
    !error.outcomeUnknown &&
    (retryableStatuses.has(error.status) ||
      (idempotent && idempotentStatuses.has(error.status)))
  );
}

export interface YdbErrorClassification {
  readonly kind:
    | 'unique'
    | 'ensure'
    | 'referential'
    | 'conflict'
    | 'overloaded'
    | 'unavailable'
    | 'session'
    | 'transport'
    | 'timeout'
    | 'cancelled'
    | 'query'
    | 'unknown';
  readonly status?: number;
  readonly outcomeUnknown: boolean;
  readonly retryable: boolean;
  readonly retryableIfIdempotent: boolean;
  readonly uniqueViolation: boolean;
  readonly ensure?: { readonly message: string };
}

/** Follow wrappers, preserving the primary failure of transaction aggregates. */
export function classifyYdbError(error: unknown): YdbErrorClassification {
  const seen = new Set<unknown>();
  let outcomeUnknown = false;
  while (typeof error === 'object' && error !== null && !seen.has(error)) {
    seen.add(error);
    if ('outcomeUnknown' in error && error.outcomeUnknown === true)
      outcomeUnknown = true;
    if (error instanceof AggregateError) {
      error = error.errors[0];
      continue;
    }
    if (error instanceof YDBError) {
      error = normalizeError(error, 'query');
      continue;
    }
    if (error instanceof YdbQueryError || error instanceof YdbTransportError) {
      outcomeUnknown ||= error.outcomeUnknown;
      const status = error instanceof YdbQueryError ? error.status : undefined;
      const uniqueViolation =
        error instanceof YdbQueryError && error.uniqueViolation;
      const ensure = error instanceof YdbQueryError ? error.ensure : undefined;
      let kind: YdbErrorClassification['kind'];
      if (uniqueViolation) kind = 'unique';
      else if (ensure) kind = 'ensure';
      else if (error instanceof YdbTransportError)
        kind =
          error.grpcCode === 1
            ? 'cancelled'
            : error.grpcCode === 4
              ? 'timeout'
              : 'transport';
      else if (status === Status.ABORTED) kind = 'conflict';
      else if (status === Status.OVERLOADED) kind = 'overloaded';
      else if (status === Status.UNAVAILABLE) kind = 'unavailable';
      else if (status !== undefined && deadSessionStatuses.has(status))
        kind = 'session';
      else if (status === Status.TIMEOUT) kind = 'timeout';
      else if (status === Status.CANCELLED) kind = 'cancelled';
      else kind = 'query';
      const eligible =
        !outcomeUnknown && !uniqueViolation && !ensure && kind !== 'cancelled';
      return {
        kind,
        status,
        outcomeUnknown,
        uniqueViolation,
        ensure,
        retryable: eligible && isRetryableYdbError(error, false),
        retryableIfIdempotent: eligible && isRetryableYdbError(error, true),
      };
    }
    if ('code' in error && error.code === 'YDB.REFERENTIAL_ACTION')
      return {
        kind: 'referential',
        outcomeUnknown,
        retryable: false,
        retryableIfIdempotent: false,
        uniqueViolation: false,
      };
    if ('cause' in error) error = error.cause;
    else break;
  }
  return {
    kind: 'unknown',
    outcomeUnknown,
    retryable: false,
    retryableIfIdempotent: false,
    uniqueViolation: false,
  };
}

/** Sessions that YDB reported as unusable; the pool must not hand them out again. */
export const deadSessionStatuses = new Set<number>([
  Status.BAD_SESSION,
  Status.SESSION_EXPIRED,
  Status.SESSION_BUSY,
]);

export function taintsSession(error: unknown): boolean {
  return (
    error instanceof YdbTransportError ||
    (error instanceof YdbQueryError && deadSessionStatuses.has(error.status))
  );
}
