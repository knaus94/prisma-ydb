import { create } from '@bufbuild/protobuf';
import {
  ValueSchema,
  Type_PrimitiveTypeId,
  type Value as WireValue,
} from '@ydbjs/api/value';
import { type Value } from '@ydbjs/value';
import { PrimitiveType } from '@ydbjs/value/primitive';

const limit = 4291747200000;
const microsLimit = BigInt(limit) * 1000n;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/;
const timestampType = new PrimitiveType(Type_PrimitiveTypeId.TIMESTAMP);

const canonicalTimestamp =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/;
const monthDays = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function twoDigits(text: string, offset: number): number {
  return (text.charCodeAt(offset) - 48) * 10 + text.charCodeAt(offset + 1) - 48;
}

/** Called only after a fixed-width date/timestamp grammar has checked the digits. */
function validCalendarDate(text: string): boolean {
  const year = twoDigits(text, 0) * 100 + twoDigits(text, 2);
  const month = twoDigits(text, 5);
  const day = twoDigits(text, 8);
  if (year < 1970 || year > 2105 || month < 1 || month > 12 || day < 1)
    return false;
  const maxDay =
    month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
      ? 29
      : monthDays[month - 1];
  return day <= maxDay;
}

/** Validate the common three/six-fraction-digit forms without Date allocation. */
export function isCanonicalYdbTimestamp(text: string): boolean {
  return (
    (text.length === 24 || text.length === 27) &&
    canonicalTimestamp.test(text) &&
    validCalendarDate(text) &&
    twoDigits(text, 11) < 24 &&
    twoDigits(text, 14) < 60 &&
    twoDigits(text, 17) < 60
  );
}

export function dateText(value: unknown): string {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof text !== 'string' || !datePattern.test(text))
    throw new TypeError('Date requires YYYY-MM-DD or a JavaScript Date');
  if (text.length === 10 && validCalendarDate(text)) return text;
  const instant = new Date(`${text}T00:00:00.000Z`);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.getTime() < 0 ||
    instant.getTime() >= limit ||
    instant.toISOString().slice(0, 10) !== text
  )
    throw new RangeError(
      'Date requires a real calendar day in the YDB 1970–2105 range',
    );
  return text;
}

export function timestampText(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text === 'string' && isCanonicalYdbTimestamp(text))
    return text.length === 27 ? text : text.slice(0, -1) + '000Z';
  const match = typeof text === 'string' && timestampPattern.exec(text);
  if (!match)
    throw new TypeError(
      'Timestamp requires an ISO UTC timestamp with at most six fractional digits',
    );
  const fraction = (match[2] ?? '').padEnd(6, '0');
  const milliseconds = `${match[1]}.${fraction.slice(0, 3)}Z`;
  const instant = new Date(milliseconds);
  if (
    !Number.isFinite(instant.getTime()) ||
    instant.getTime() < 0 ||
    instant.getTime() >= limit ||
    instant.toISOString() !== milliseconds
  )
    throw new RangeError(
      'Timestamp requires a real instant in the YDB 1970–2105 range',
    );
  return `${match[1]}.${fraction}Z`;
}

export function timestampMicros(value: unknown): bigint {
  const text = timestampText(value);
  return (
    BigInt(new Date(text.slice(0, 23) + 'Z').getTime()) * 1000n +
    BigInt(text.slice(23, 26))
  );
}

export function timestampFromMicros(value: bigint): string {
  if (value < 0n || value >= microsLimit)
    throw new RangeError('Timestamp outside YDB range');
  return (
    new Date(Number(value / 1000n)).toISOString().slice(0, 23) +
    (value % 1000n).toString().padStart(3, '0') +
    'Z'
  );
}

export class TimestampMicrosValue implements Value<PrimitiveType> {
  readonly type = timestampType;
  readonly value: bigint;
  constructor(value: string | Date) {
    this.value = timestampMicros(value);
  }
  encode(): WireValue {
    return create(ValueSchema, {
      value: { case: 'uint64Value', value: this.value },
    });
  }
}
