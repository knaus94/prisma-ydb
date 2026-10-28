import { create } from '@bufbuild/protobuf';
import {
  TypeSchema,
  ValueSchema,
  type Type as WireType,
  type Value as WireValue,
} from '@ydbjs/api/value';
import { TypeKind, type Type, type Value } from '@ydbjs/value';

/** YDB Decimal's exact decimal string form; floating point numbers are never accepted. */
export function decimalText(
  value: unknown,
  precision: number,
  scale: number,
): string {
  if (
    !Number.isInteger(precision) ||
    precision < 1 ||
    precision > 35 ||
    !Number.isInteger(scale) ||
    scale < 0 ||
    scale > precision
  )
    throw new RangeError(
      'Decimal requires precision 1..35 and scale 0..precision',
    );
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value))
    throw new TypeError(
      'Decimal requires a finite decimal string without exponent notation',
    );
  const negative = value.startsWith('-');
  const start = negative ? 1 : 0;
  const point = value.indexOf('.');
  const integerEnd = point === -1 ? value.length : point;
  const zeroInteger = value.charCodeAt(start) === 48;
  // Canonical fixed-scale values need neither BigInt parsing nor formatting.
  if (
    value.charCodeAt(value.length - 1) >= 48 &&
    value.charCodeAt(value.length - 1) <= 57 &&
    (scale === 0
      ? point === -1
      : point > start && point === value.length - scale - 1) &&
    (!zeroInteger || integerEnd === start + 1) &&
    integerEnd - start - (zeroInteger ? 1 : 0) + scale <= precision
  )
    return negative && !/[1-9]/.test(value) ? value.slice(1) : value;
  const [integer, fraction = ''] = (negative ? value.slice(1) : value).split(
    '.',
  );
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale)))
    throw new RangeError('Decimal scale would lose nonzero digits');
  const magnitude = BigInt(
    integer + fraction.slice(0, scale).padEnd(scale, '0'),
  );
  if (magnitude >= 10n ** BigInt(precision))
    throw new RangeError('Decimal precision overflow');
  const digits = magnitude.toString().padStart(scale + 1, '0');
  return `${negative && magnitude !== 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

export class DecimalType implements Type {
  readonly kind = TypeKind.DECIMAL;
  constructor(
    readonly precision = 22,
    readonly scale = 9,
  ) {
    decimalText('0', precision, scale);
  }
  encode(): WireType {
    return create(TypeSchema, {
      type: {
        case: 'decimalType',
        value: { precision: this.precision, scale: this.scale },
      },
    });
  }
}

/** Exact native YQL parameter. Works with Optional and all @ydbjs value containers. */
export class DecimalValue implements Value<DecimalType> {
  readonly type: DecimalType;
  readonly value: string;
  constructor(value: string, precision = 22, scale = 9) {
    this.type = new DecimalType(precision, scale);
    this.value = decimalText(value, precision, scale);
  }
  encode(): WireValue {
    const integer = BigInt(this.value.replace('.', ''));
    const bits = BigInt.asUintN(128, integer);
    return create(ValueSchema, {
      value: { case: 'low128', value: bits & ((1n << 64n) - 1n) },
      high128: bits >> 64n,
    });
  }
}
