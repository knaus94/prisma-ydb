export function ydbDurationSeconds(value: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value,
  );
  if (
    !match ||
    !match.slice(1).some((part) => part !== undefined) ||
    value.endsWith('T')
  )
    throw new Error(
      'TTL expireAfter must be a non-empty ISO-8601 duration with whole days, hours, minutes or seconds.',
    );
  const seconds =
    Number(match[1] ?? 0) * 86400 +
    Number(match[2] ?? 0) * 3600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
  if (!Number.isSafeInteger(seconds) || seconds > 9223372036854)
    throw new Error('TTL expireAfter exceeds the YDB Interval range.');
  return seconds;
}

export const ydbDuration = (seconds: number): string => `PT${seconds}S`;

/** Quote an identifier, including a database-relative table path. */
export function quoteYdbIdentifier(value: string): string {
  if (value.includes('\0'))
    throw new Error('YDB identifiers cannot contain NUL.');
  return '`' + value.replaceAll('\\', '\\\\').replaceAll('`', '\\`') + '`';
}
