import { create } from '@bufbuild/protobuf';
import {
  TypeSchema,
  ValueSchema,
  type Type as WireType,
  type Value as WireValue,
} from '@ydbjs/api/value';
import { parameterType } from '../driver/values.js';
import type { YdbParameter } from '../driver/types.js';
import { bigIntsFromUuid } from '@ydbjs/value/uuid';
import {
  CodecDescriptorImpl,
  CodecImpl,
  dataTypeId,
  renderTsLiteral,
  type CodecTrait,
  type AnyCodecDescriptor,
  type Codec,
} from '@prisma/orm-framework/components/codec';
import { sqlDataType } from '@prisma/orm-family-sql/contract/data-type';
import type { JsonValue } from '@prisma/orm-framework/contract/types';
import type { Value } from '@ydbjs/value';
import {
  Bool,
  Bytes,
  Double,
  Int32,
  Int64,
  Json,
  Text,
  Date as YdbDate,
  Uint64,
} from '@ydbjs/value/primitive';
import { DecimalValue, decimalText } from './decimal.js';
import { UuidValue, uuidText } from '../driver/uuid.js';
import { ydbJsonForm } from '../driver/json-form.js';
export { ydbJsonForm } from '../driver/json-form.js';
import {
  dateText,
  isCanonicalYdbTimestamp,
  timestampText,
  timestampFromMicros,
  timestampMicros,
  TimestampMicrosValue,
} from './temporal.js';

export class YdbJsonElement {
  constructor(readonly value: JsonValue) {}
}

type Conversion<T> = {
  read(value: unknown): T;
  decode?(value: unknown): T;
  wire(value: T): Value;
  json(value: T): JsonValue;
  fromJson(value: JsonValue): T;
  literal?(value: JsonValue): string | undefined;
};

class YdbCodec<
  Id extends string,
  Traits extends readonly CodecTrait[],
  T,
> extends CodecImpl<Id, Traits, unknown, T> {
  constructor(
    descriptor: AnyCodecDescriptor & { codecId: Id; traits: Traits },
    private readonly conversion: Conversion<T>,
  ) {
    super(descriptor);
  }
  async encode(value: T): Promise<Value> {
    const read = this.conversion.read(value);
    return Object.assign(this.conversion.wire(read), {
      [ydbJsonForm]: () => this.conversion.json(read),
    });
  }
  async decode(value: unknown): Promise<T> {
    if (value instanceof YdbJsonElement)
      return this.conversion.fromJson(value.value);
    return (this.conversion.decode ?? this.conversion.read)(value);
  }
  encodeJson(value: T): JsonValue {
    return this.conversion.json(this.conversion.read(value));
  }
  decodeJson(value: JsonValue): T {
    return this.conversion.fromJson(value);
  }
}

export class YdbCodecDescriptor<
  Id extends string,
  Traits extends readonly CodecTrait[],
  T,
> extends CodecDescriptorImpl {
  private cachedWireType?: WireType;
  readonly paramsSchema = undefined;
  readonly dataType;
  constructor(
    readonly codecId: Id,
    readonly traits: Traits,
    readonly yqlType: string,
    private readonly conversion: Conversion<T>,
    readonly outputType: string,
    dataTypeName?: string,
  ) {
    super();
    this.dataType = dataTypeId(dataTypeName ?? codecId.replace(/@\d+$/, ''));
  }
  override renderOutputType(): string {
    return this.outputType;
  }
  override readonly renderValueLiteral = (
    value: JsonValue,
  ): string | undefined => this.conversion.literal?.(value);
  factory() {
    return () => new YdbCodec(this, this.conversion);
  }
  /** Synchronous wire encoding for paths outside Prisma's codec pipeline (bulk writes). */
  wire(value: unknown): Value {
    return this.conversion.wire(this.conversion.read(value));
  }
  wireType(): WireType {
    return (this.cachedWireType ??= parameterType(this.yqlType));
  }
  fromJson(value: JsonValue): T {
    return this.conversion.fromJson(value);
  }
  /** Resolve conversions once for native model row loops. */
  nativeConversions(): NativeCodecConversions {
    if (this.codecId === 'ydb/decimal@1') {
      const params = /^Decimal\((\d+),(\d+)\)$/.exec(this.yqlType);
      if (!params) throw new TypeError('Invalid Decimal descriptor type');
      return nativeCodecConversions(this.codecId, {
        precision: Number(params[1]),
        scale: Number(params[2]),
      });
    }
    const conversion = this.conversion;
    const decode = conversion.decode ?? conversion.read;
    return {
      decode: (value) =>
        value instanceof YdbJsonElement
          ? conversion.fromJson(value.value)
          : decode(value),
      encode: nativeWireEncoder(this.codecId, conversion.read),
      encodeJson: (value) => conversion.json(conversion.read(value)),
      decodeJson: conversion.fromJson,
    };
  }
}

function assertString(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Expected a string');
  return value;
}
function assertBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('Expected a boolean');
  return value;
}
function assertNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError('Expected a finite number');
  return value;
}
function assertInt32(value: unknown): number {
  const n = assertNumber(value);
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647)
    throw new RangeError('Int32 is outside its exact range');
  return n;
}
function assertInteger(value: unknown, unsigned = false): bigint {
  if (typeof value === 'number' && Number.isSafeInteger(value))
    value = BigInt(value);
  if (typeof value !== 'bigint')
    throw new TypeError(
      'Int64/Uint64 requires bigint or a safe integer number',
    );
  if (
    value < (unsigned ? 0n : -(1n << 63n)) ||
    value > (unsigned ? (1n << 64n) - 1n : (1n << 63n) - 1n)
  )
    throw new RangeError('64-bit integer overflow');
  return value;
}
function integerJson(value: JsonValue, unsigned = false): bigint {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value))
    throw new TypeError('64-bit JSON values must be decimal strings');
  return assertInteger(BigInt(value), unsigned);
}
function safeNumber(value: unknown): number {
  const n = typeof value === 'bigint' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n))
    throw new RangeError(
      'Integer result exceeds Number.MAX_SAFE_INTEGER; use countBigInt/sumBigInt',
    );
  return n;
}
function assertDate(value: unknown): Date {
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    value.getTime() < 0 ||
    value.getTime() >= 4291747200000
  )
    throw new RangeError(
      'Timestamp requires a valid Date in the YDB 1970–2105 range',
    );
  return value;
}
function timestampJson(value: JsonValue): Date {
  const text = assertString(value);
  if (isCanonicalYdbTimestamp(text)) return new Date(text);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(
    text,
  );
  if (!match)
    throw new TypeError('Timestamp JSON requires an ISO UTC timestamp');
  const fraction = match[2] ?? '';
  const canonical = `${match[1]}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
  const date = assertDate(new Date(canonical));
  if (date.toISOString() !== canonical)
    throw new RangeError('Timestamp JSON contains an invalid calendar date');
  return date;
}
function assertBytes(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array))
    throw new TypeError('String binary columns require Uint8Array');
  return value;
}
function assertJson(value: unknown): JsonValue {
  // A JSON round trip refuses bigint, cyclic graphs, undefined and custom objects.
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(assertJson);
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, assertJson(entry)]),
    );
  }
  throw new TypeError('Expected a JSON value');
}

const equality = ['equality'] as const;
const numeric = ['equality', 'order', 'numeric'] as const;
export const ydbUtf8 = new YdbCodecDescriptor(
  'ydb/utf8@1',
  ['equality', 'order', 'textual'] as const,
  'Utf8',
  {
    read: assertString,
    wire: (value: string) => new Text(value),
    json: assertString,
    fromJson: assertString,
    literal: (value) =>
      typeof value === 'string' ? renderTsLiteral(value) : undefined,
  },
  'string',
);
// Native UUID ordering follows YDB byte layout, not JS UUID string ordering.
export const ydbUuid = new YdbCodecDescriptor(
  'ydb/uuid@1',
  ['equality', 'order'] as const,
  'Uuid',
  {
    read: uuidText,
    wire: (value: string) => new UuidValue(value),
    json: uuidText,
    fromJson: uuidText,
    literal: (value) => renderTsLiteral(uuidText(value)),
  },
  'string',
);
export const ydbInt32 = new YdbCodecDescriptor(
  'ydb/int32@1',
  numeric,
  'Int32',
  {
    read: assertInt32,
    wire: (value: number) => new Int32(value),
    json: assertInt32,
    fromJson: assertInt32,
  },
  'number',
);
export const ydbInt64 = new YdbCodecDescriptor(
  'ydb/int64@1',
  numeric,
  'Int64',
  {
    read: assertInteger,
    wire: (value) => new Int64(value),
    json: (value) => value.toString(),
    fromJson: integerJson,
  },
  'bigint',
);
export const ydbUint64 = new YdbCodecDescriptor(
  'ydb/uint64@1',
  numeric,
  'Uint64',
  {
    read: (value) => assertInteger(value, true),
    wire: (value) => new Uint64(value),
    json: (value) => value.toString(),
    fromJson: (value) => integerJson(value, true),
  },
  'bigint',
);
export const ydbNumber = new YdbCodecDescriptor(
  'ydb/number@1',
  numeric,
  'Int64',
  {
    read: safeNumber,
    wire: (value) => new Int64(BigInt(value)),
    json: (value) => value.toString(),
    fromJson: (value) => safeNumber(integerJson(value)),
  },
  'number',
  'ydb/int64',
);
export const ydbBool = new YdbCodecDescriptor(
  'ydb/bool@1',
  ['equality', 'boolean'] as const,
  'Bool',
  {
    read: assertBoolean,
    wire: (value: boolean) => new Bool(value),
    json: assertBoolean,
    fromJson: assertBoolean,
  },
  'boolean',
);
export const ydbDouble = new YdbCodecDescriptor(
  'ydb/double@1',
  numeric,
  'Double',
  {
    read: assertNumber,
    wire: (value: number) => new Double(value),
    json: assertNumber,
    fromJson: assertNumber,
  },
  'number',
);
export const ydbTimestamp = new YdbCodecDescriptor(
  'ydb/timestamp@1',
  ['equality', 'order'] as const,
  'Timestamp',
  {
    read: (value): Date | bigint | TimestampMicrosValue => {
      if (typeof value === 'bigint') {
        assertTimestampMicros(value);
        return value;
      }
      if (value instanceof TimestampMicrosValue) {
        assertTimestampMicros(value.value);
        return value;
      }
      return assertDate(value);
    },
    decode: (value) => {
      if (typeof value === 'bigint') {
        assertTimestampMicros(value);
        return assertDate(new Date(Number(value / 1000n)));
      }
      return assertDate(value);
    },
    wire: (value) => new TimestampMicrosValue(timestampInputMicros(value)),
    json: (value) => {
      if (value instanceof Date) return value.toISOString();
      const micros = timestampInputMicros(value);
      return micros % 1000n === 0n
        ? new Date(Number(micros / 1000n)).toISOString()
        : timestampFromMicros(micros);
    },
    fromJson: timestampJson,
  },
  'Date',
);
export const ydbJson = new YdbCodecDescriptor(
  'ydb/json@1',
  [] as const,
  'Json',
  {
    read: assertJson,
    decode: (value) => value as JsonValue,
    wire: (value) => new Json(JSON.stringify(value)),
    json: assertJson,
    fromJson: assertJson,
  },
  'import("@prisma/orm-framework/contract/types").JsonValue',
);
export const ydbString = new YdbCodecDescriptor(
  'ydb/string@1',
  equality,
  'String',
  {
    read: assertBytes,
    wire: (value) => new Bytes(value),
    json: (value) => Buffer.from(value).toString('base64'),
    fromJson: (value) =>
      new Uint8Array(Buffer.from(assertString(value), 'base64')),
  },
  'Uint8Array',
);
export const ydbDate = new YdbCodecDescriptor(
  'ydb/date@1',
  ['equality', 'order'] as const,
  'Date',
  {
    read: dateText,
    decode: (value) => dateText(value),
    wire: (value) => new YdbDate(new Date(`${value}T00:00:00.000Z`)),
    json: dateText,
    fromJson: dateText,
  },
  'string',
);
export const ydbTimestampUs = new YdbCodecDescriptor(
  'ydb/timestamp-us@1',
  ['equality', 'order'] as const,
  'Timestamp',
  {
    read: timestampText,
    decode: (value) =>
      typeof value === 'bigint'
        ? timestampFromMicros(value)
        : timestampText(value),
    wire: (value: string) => new TimestampMicrosValue(value),
    json: timestampText,
    fromJson: timestampText,
  },
  'string',
  'ydb/timestamp',
);

export function decimalParams(value: unknown = {}): {
  precision: number;
  scale: number;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('Decimal parameters must be an object');
  const params = value as Record<string, unknown>;
  if (Object.hasOwn(params, 'precision') !== Object.hasOwn(params, 'scale'))
    throw new TypeError('Decimal requires both precision and scale');
  if (Object.keys(params).some((key) => key !== 'precision' && key !== 'scale'))
    throw new TypeError('Unknown Decimal parameter');
  const precision = params['precision'] ?? 22;
  const scale = params['scale'] ?? 9;
  if (typeof precision !== 'number' || typeof scale !== 'number')
    throw new TypeError('Decimal precision and scale must be numbers');
  decimalText('0', precision, scale);
  return { precision, scale };
}

function assertTimestampMicros(value: bigint): void {
  if (value < 0n || value >= 4291747200000000n)
    throw new RangeError('Timestamp outside YDB range');
}

function timestampInputMicros(
  value: Date | bigint | TimestampMicrosValue,
): bigint {
  return typeof value === 'bigint'
    ? value
    : value instanceof TimestampMicrosValue
      ? value.value
      : BigInt(value.getTime()) * 1000n;
}

class YdbDecimalDescriptor extends CodecDescriptorImpl<{
  precision?: number;
  scale?: number;
}> {
  readonly codecId = 'ydb/decimal@1';
  readonly traits = numeric;
  readonly dataType = dataTypeId('ydb/decimal');
  readonly yqlType = 'Decimal(22,9)';
  readonly paramsSchema = {
    '~standard': {
      version: 1 as const,
      vendor: 'prisma-ydb',
      validate(value: unknown) {
        try {
          return { value: decimalParams(value) };
        } catch (error) {
          return { issues: [{ message: String(error) }] };
        }
      },
    },
  };
  with(precision: number, scale: number) {
    decimalText('0', precision, scale);
    const read = (value: unknown) => decimalText(value, precision, scale);
    return new YdbCodecDescriptor(
      'ydb/decimal@1',
      numeric,
      `Decimal(${precision},${scale})`,
      {
        read,
        wire: (value: string) => new DecimalValue(value, precision, scale),
        json: read,
        fromJson: read,
      },
      'string',
    );
  }
  private defaultDescriptor?: ReturnType<YdbDecimalDescriptor['with']>;
  private defaults() {
    return (this.defaultDescriptor ??= this.with(22, 9));
  }
  wireType(): WireType {
    return this.defaults().wireType();
  }
  wire(value: unknown): Value {
    return this.defaults().wire(value);
  }
  nativeConversions(): NativeCodecConversions {
    return nativeCodecConversions(this.codecId);
  }
  override renderOutputType() {
    return 'string';
  }
  factory(params: { precision?: number; scale?: number } = {}) {
    const { precision, scale } = decimalParams(params);
    const read = (value: unknown) => decimalText(value, precision, scale);
    return () =>
      new YdbCodec(this, {
        read,
        wire: (value: string) => new DecimalValue(value, precision, scale),
        json: read,
        fromJson: read,
      });
  }
}
export const ydbDecimal = new YdbDecimalDescriptor();

export const ydbCodecDescriptors = [
  ydbUtf8,
  ydbUuid,
  ydbInt32,
  ydbInt64,
  ydbUint64,
  ydbNumber,
  ydbBool,
  ydbDouble,
  ydbTimestamp,
  ydbDate,
  ydbTimestampUs,
  ydbJson,
  ydbString,
  ydbDecimal,
] as const;
export const ydbDataTypes = [
  ...new Set(ydbCodecDescriptors.map((codec) => codec.dataType)),
].map((id) => {
  const descriptor = ydbCodecDescriptors.find((codec) => codec.dataType === id);
  if (!descriptor) throw new TypeError(`Missing YDB descriptor for ${id}`);
  const name = descriptor.yqlType;
  return sqlDataType(id, {
    texts: [
      { text: name.toLowerCase(), display: name, written: true, catalog: true },
    ],
  });
});
export const ydbScalarDescriptors = {
  String: ydbUtf8,
  Uuid: ydbUuid,
  Int: ydbInt32,
  BigInt: ydbInt64,
  Boolean: ydbBool,
  Float: ydbDouble,
  DateTime: ydbTimestamp,
  Date: ydbDate,
  Timestamp: ydbTimestampUs,
  Json: ydbJson,
  Bytes: ydbString,
  Decimal: ydbDecimal,
} as const;
export type CodecTypes = {
  readonly 'ydb/uuid@1': {
    input: string;
    output: string;
    json: string;
    traits: 'equality' | 'order';
  };
  readonly 'ydb/date@1': {
    input: string | Date;
    output: string;
    json: string;
    traits: 'equality' | 'order';
  };
  readonly 'ydb/timestamp-us@1': {
    input: string | Date;
    output: string;
    json: string;
    traits: 'equality' | 'order';
  };
  readonly 'ydb/utf8@1': {
    input: string;
    output: string;
    json: string;
    traits: 'equality' | 'order' | 'textual';
  };
  readonly 'ydb/int32@1': {
    input: number;
    output: number;
    json: number;
    traits: 'equality' | 'order' | 'numeric';
  };
  readonly 'ydb/int64@1': {
    input: bigint | number;
    output: bigint;
    json: string;
    traits: 'equality' | 'order' | 'numeric';
  };
  readonly 'ydb/uint64@1': {
    input: bigint | number;
    output: bigint;
    json: string;
    traits: 'equality' | 'order' | 'numeric';
  };
  readonly 'ydb/number@1': {
    input: number;
    output: number;
    json: string;
    traits: 'equality' | 'order' | 'numeric';
  };
  readonly 'ydb/bool@1': {
    input: boolean;
    output: boolean;
    json: boolean;
    traits: 'equality' | 'boolean';
  };
  readonly 'ydb/double@1': {
    input: number;
    output: number;
    json: number;
    traits: 'equality' | 'order' | 'numeric';
  };
  readonly 'ydb/timestamp@1': {
    input: Date | bigint | TimestampMicrosValue;
    output: Date;
    json: string;
    traits: 'equality' | 'order';
  };
  readonly 'ydb/json@1': {
    input: JsonValue;
    output: JsonValue;
    json: JsonValue;
    traits: never;
  };
  readonly 'ydb/string@1': {
    input: Uint8Array;
    output: Uint8Array;
    json: string;
    traits: 'equality';
  };
  readonly 'ydb/decimal@1': {
    input: string;
    output: string;
    json: string;
    traits: 'equality' | 'order' | 'numeric';
  };
};

const codecsById = new Map<string, (typeof ydbCodecDescriptors)[number]>(
  ydbCodecDescriptors.map((codec) => [codec.codecId, codec]),
);
const jsonCodecsById = new Map<string, Codec>(
  ydbCodecDescriptors
    .filter((descriptor) => descriptor !== ydbDecimal)
    .map((descriptor) => [descriptor.codecId, descriptor.factory()()] as const),
);

export function yqlTypeForCodec(codecId: string, typeParams?: unknown): string {
  if (codecId === 'ydb/decimal@1') {
    const { precision, scale } = decimalParams(typeParams);
    return `Decimal(${precision},${scale})`;
  }
  const codec = codecsById.get(codecId);
  if (!codec) throw new TypeError(`YDB codec not registered: ${codecId}`);
  return codec.yqlType;
}

/** Encode one JavaScript value as a typed YDB value through the column's codec. */
export function encodeYdbValue(
  codecId: string,
  value: unknown,
  typeParams?: unknown,
): Value {
  if (codecId === ydbDecimal.codecId) {
    const { precision, scale } = decimalParams(typeParams);
    return new DecimalValue(
      decimalText(value, precision, scale),
      precision,
      scale,
    );
  }
  const codec = codecsById.get(codecId);
  if (!codec || !(codec instanceof YdbCodecDescriptor))
    throw new TypeError(`YDB codec not registered: ${codecId}`);
  return codec.wire(value);
}

/** Decode the codec's JSON form (the form ORM list columns and changefeeds carry). */
export function decodeYdbJson(
  codecId: string,
  value: JsonValue,
  typeParams?: unknown,
): unknown {
  if (codecId === ydbDecimal.codecId) {
    const { precision, scale } = decimalParams(typeParams);
    return decimalText(value, precision, scale);
  }
  const codec = codecsById.get(codecId);
  if (!codec || !(codec instanceof YdbCodecDescriptor))
    throw new TypeError(`YDB codec not registered: ${codecId}`);
  return codec.fromJson(value);
}

export function encodeYdbJson(
  codecId: string,
  value: unknown,
  typeParams?: unknown,
): JsonValue {
  if (codecId === ydbDecimal.codecId) {
    const { precision, scale } = decimalParams(typeParams);
    return decimalText(value, precision, scale);
  }
  const codec = jsonCodecsById.get(codecId);
  if (!codec) throw new TypeError(`YDB codec not registered: ${codecId}`);
  return codec.encodeJson(value as never);
}

export interface NativeCodecConversions {
  readonly decode: (value: unknown) => unknown;
  readonly encode: (value: unknown) => WireValue;
  readonly encodeJson: (value: unknown) => JsonValue;
  readonly decodeJson: (value: JsonValue) => unknown;
}

/** Precompile the protobuf cell encoder; read preserves the codec's input checks. */
function nativeWireEncoder(
  codecId: string,
  read: (value: unknown) => unknown,
): (value: unknown) => WireValue {
  switch (codecId) {
    case 'ydb/utf8@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'textValue', value: read(value) as string },
        });
    case 'ydb/uuid@1':
      return (value) => {
        const { low128, high128 } = bigIntsFromUuid(read(value) as string);
        return create(ValueSchema, {
          value: { case: 'low128', value: low128 },
          high128,
        });
      };
    case 'ydb/int32@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'int32Value', value: read(value) as number },
        });
    case 'ydb/int64@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'int64Value', value: read(value) as bigint },
        });
    case 'ydb/uint64@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'uint64Value', value: read(value) as bigint },
        });
    case 'ydb/number@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'int64Value', value: BigInt(read(value) as number) },
        });
    case 'ydb/bool@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'boolValue', value: read(value) as boolean },
        });
    case 'ydb/double@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'doubleValue', value: read(value) as number },
        });
    case 'ydb/string@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'bytesValue', value: read(value) as Uint8Array },
        });
    case 'ydb/json@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'textValue', value: JSON.stringify(read(value)) },
        });
    case 'ydb/date@1':
      return (value) =>
        create(ValueSchema, {
          value: {
            case: 'uint32Value',
            value:
              new Date(`${read(value)}T00:00:00.000Z`).getTime() / 86400000,
          },
        });
    case 'ydb/timestamp@1':
      return (value) =>
        create(ValueSchema, {
          value: {
            case: 'uint64Value',
            value: timestampInputMicros(
              read(value) as Date | bigint | TimestampMicrosValue,
            ),
          },
        });
    case 'ydb/timestamp-us@1':
      return (value) =>
        create(ValueSchema, {
          value: { case: 'uint64Value', value: timestampMicros(read(value)) },
        });
    default:
      throw new TypeError(`YDB codec not registered: ${codecId}`);
  }
}

/** Synchronous native conversions with the same decoder as YdbCodec.decode. */
export function nativeCodecConversions(
  codecId: string,
  typeParams?: unknown,
): NativeCodecConversions {
  if (codecId === ydbDecimal.codecId) {
    const { precision, scale } = decimalParams(typeParams);
    const read = (value: unknown) => decimalText(value, precision, scale);
    return {
      decode: (value) =>
        read(value instanceof YdbJsonElement ? value.value : value),
      encode: (value) => {
        const bits = BigInt.asUintN(128, BigInt(read(value).replace('.', '')));
        return create(ValueSchema, {
          value: { case: 'low128', value: bits & ((1n << 64n) - 1n) },
          high128: bits >> 64n,
        });
      },
      encodeJson: read,
      decodeJson: read,
    };
  }
  const codec = codecsById.get(codecId);
  if (!codec || !(codec instanceof YdbCodecDescriptor))
    throw new TypeError(`YDB codec not registered: ${codecId}`);
  return codec.nativeConversions();
}

/** A value-free native parameter type with synchronous encoding and decoding. */
export interface YdbTypeDescriptor<Input = unknown, Output = Input> {
  readonly yqlType: string;
  readonly __input?: Input;
  readonly __output?: Output;
  wireType(): WireType;
  wire(value: Input): YdbParameter;
  nativeConversions(): Pick<NativeCodecConversions, 'decode' | 'encode'>;
}
export type YdbTypeInput<D> = D extends {
  readonly codecId: infer Id extends keyof CodecTypes;
}
  ? CodecTypes[Id]['input']
  : D extends YdbTypeDescriptor<infer Input, unknown>
    ? Input
    : never;
export type YdbTypeOutput<D> = D extends {
  readonly codecId: infer Id extends keyof CodecTypes;
}
  ? CodecTypes[Id]['output']
  : D extends YdbTypeDescriptor<unknown, infer Output>
    ? Output
    : never;

function containerDescriptor<Input, Output>(
  yqlType: string,
  type: WireType,
  encode: (value: Input) => WireValue,
  decode: (value: unknown) => Output,
): YdbTypeDescriptor<Input, Output> {
  return {
    yqlType,
    wireType: () => type,
    wire: (value) => ({ type, value: encode(value) }),
    nativeConversions: () => ({
      encode: (value) => encode(value as Input),
      decode,
    }),
  };
}

export function optional<D extends YdbTypeDescriptor>(
  item: D,
): YdbTypeDescriptor<
  YdbTypeInput<D> | null | undefined,
  YdbTypeOutput<D> | null
> {
  const codec = item.nativeConversions();
  const type = create(TypeSchema, {
    type: { case: 'optionalType', value: { item: item.wireType() } },
  });
  const nullValue = create(ValueSchema, {
    value: { case: 'nullFlagValue', value: 0 },
  });
  const nested = item.wireType().type.case === 'optionalType';
  return containerDescriptor(
    `Optional<${item.yqlType}>`,
    type,
    (value) =>
      value == null
        ? nullValue
        : nested
          ? create(ValueSchema, {
              value: { case: 'nestedValue', value: codec.encode(value) },
            })
          : codec.encode(value),
    (value) =>
      value == null ? null : (codec.decode(value) as YdbTypeOutput<D>),
  );
}

export function list<D extends YdbTypeDescriptor>(
  item: D,
): YdbTypeDescriptor<readonly YdbTypeInput<D>[], YdbTypeOutput<D>[]> {
  const codec = item.nativeConversions();
  const type = create(TypeSchema, {
    type: { case: 'listType', value: { item: item.wireType() } },
  });
  return containerDescriptor(
    `List<${item.yqlType}>`,
    type,
    (value) => {
      if (!Array.isArray(value))
        throw new TypeError('YQL list requires an array');
      return create(ValueSchema, { items: value.map(codec.encode) });
    },
    (value) => {
      if (!Array.isArray(value))
        throw new TypeError('YQL list requires an array');
      return value.map(codec.decode) as YdbTypeOutput<D>[];
    },
  );
}

export function struct<
  const Fields extends Readonly<Record<string, YdbTypeDescriptor>>,
>(
  fields: Fields,
): YdbTypeDescriptor<
  { [Key in keyof Fields]: YdbTypeInput<Fields[Key]> },
  { [Key in keyof Fields]: YdbTypeOutput<Fields[Key]> }
> {
  const entries = Object.entries(fields).map(([name, descriptor]) => {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
      ['__proto__', 'constructor', 'prototype'].includes(name)
    )
      throw new TypeError(`Invalid YQL struct member ${name}`);
    return { name, descriptor, codec: descriptor.nativeConversions() };
  });
  const names = new Set(entries.map((entry) => entry.name));
  const type = create(TypeSchema, {
    type: {
      case: 'structType',
      value: {
        members: entries.map(({ name, descriptor }) => ({
          name,
          type: descriptor.wireType(),
        })),
      },
    },
  });
  const object = (value: unknown): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TypeError('YQL struct requires an object');
    return value as Record<string, unknown>;
  };
  return containerDescriptor(
    `Struct<${entries.map(({ name, descriptor }) => `\`${name}\`:${descriptor.yqlType}`).join(',')}>`,
    type,
    (value) => {
      const row = object(value);
      for (const name of Object.keys(row))
        if (!names.has(name))
          throw new TypeError(`Unknown YQL struct member ${name}`);
      return create(ValueSchema, {
        items: entries.map(({ name, codec }) => {
          if (!Object.hasOwn(row, name))
            throw new TypeError(`Missing YQL struct member ${name}`);
          return codec.encode(row[name]);
        }),
      });
    },
    (value) => {
      const row = object(value);
      const result: Record<string, unknown> = {};
      for (const { name, codec } of entries) {
        if (!Object.hasOwn(row, name))
          throw new TypeError(`Missing YQL struct member ${name}`);
        result[name] = codec.decode(row[name]);
      }
      return result as { [Key in keyof Fields]: YdbTypeOutput<Fields[Key]> };
    },
  );
}
