import { retryDefaults } from './retry.js';
import type { YdbDriverOptions, YdbRetryOptions } from './types.js';

export type Options = Required<Omit<YdbDriverOptions, 'onEvent' | 'retry'>> &
  Pick<YdbDriverOptions, 'onEvent'> & {
    readonly retry: false | Required<YdbRetryOptions>;
  };

const defaults = {
  maxSessions: 16,
  minSessions: 0,
  maxWaiters: 128,
  acquireTimeoutMs: 10_000,
  queryTimeoutMs: 30_000,
  transactionTimeoutMs: 60_000,
  sessionMaxIdleMs: 300_000,
  sessionMaxAgeMs: 3_600_000,
  sessionCloseTimeoutMs: 2_000,
  closeTimeoutMs: 30_000,
  maxResultRows: 100_000,
  maxResultBytes: 32 * 1024 * 1024,
  includeServerIssues: false,
  readTransactionMode: 'snapshotReadOnly',
  statsMode: 'none',
} as const satisfies Omit<Options, 'onEvent' | 'retry'>;

const enumerations = {
  readTransactionMode: ['snapshotReadOnly', 'serializable'],
  statsMode: ['none', 'basic'],
} as const;

function integer(name: string, value: unknown, min: number): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min)
    throw new TypeError(
      `YDB ${name} must be a safe integer ${min > 0 ? 'greater than zero' : 'of zero or more'}`,
    );
}

function resolveRetry(
  input: YdbDriverOptions['retry'],
): false | Required<YdbRetryOptions> {
  if (input === false) return false;
  if (input === undefined) return retryDefaults;
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new TypeError('YDB retry must be false or an options object');
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(retryDefaults, key))
      throw new TypeError(`Unknown YDB retry option ${key}`);
    integer(`retry.${key}`, value, 1);
  }
  return { ...retryDefaults, ...input } as Required<YdbRetryOptions>;
}

/** Validates user input strictly: unknown keys and malformed values fail fast. */
export function resolveOptions(input: YdbDriverOptions = {}): Options {
  const provided = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  for (const key of Object.keys(provided))
    if (!Object.hasOwn(defaults, key) && key !== 'onEvent' && key !== 'retry')
      throw new TypeError(`Unknown YDB option ${key}`);
  const result = {
    ...defaults,
    ...provided,
    retry: resolveRetry(input.retry),
  } as Options;
  for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
    const value = result[key];
    if (key === 'includeServerIssues') {
      if (typeof value !== 'boolean')
        throw new TypeError('YDB includeServerIssues must be a boolean');
    } else if (key in enumerations) {
      const allowed: readonly string[] =
        enumerations[key as keyof typeof enumerations];
      if (!allowed.includes(value as string))
        throw new TypeError(`YDB ${key} must be one of ${allowed.join(', ')}`);
    } else integer(key, value, key === 'minSessions' ? 0 : 1);
  }
  if (result.onEvent !== undefined && typeof result.onEvent !== 'function')
    throw new TypeError('YDB onEvent must be a function');
  if (result.minSessions > result.maxSessions)
    throw new TypeError('YDB minSessions must not exceed maxSessions');
  return result;
}
