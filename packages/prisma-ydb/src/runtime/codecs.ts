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
  Timestamp,
  Date as YdbDate,
  Uint64,
} from '@ydbjs/value/primitive';
import { DecimalValue, decimalText } from './decimal.js';
import { UuidValue, uuidText } from '../driver/uuid.js';
import { ydbJsonForm } from '../driver/json-form.js';
export { ydbJsonForm } from '../driver/json-form.js';
import {
  dateText,
  timestampText,
  timestampFromMicros,
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
  fromJson(value: JsonValue): T {
    return this.conversion.fromJson(value);
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
  if (typeof value !== 'bigint')
    throw new TypeError(
      'Int64/Uint64 requires bigint; implicit number conversion is unsafe',
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
    read: assertDate,
    decode: (value) => {
      if (typeof value === 'bigint') {
        return assertDate(new Date(Number(value / 1000n)));
      }
      return assertDate(value);
    },
    wire: (value) => new Timestamp(value),
    json: (value) => value.toISOString(),
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
    input: bigint;
    output: bigint;
    json: string;
    traits: 'equality' | 'order' | 'numeric';
  };
  readonly 'ydb/uint64@1': {
    input: bigint;
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
    input: Date;
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
