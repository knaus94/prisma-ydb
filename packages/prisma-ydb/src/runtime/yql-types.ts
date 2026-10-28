import { create } from '@bufbuild/protobuf';
import {
  Type_PrimitiveTypeId as PrimitiveId,
  ValueSchema,
  type Type,
  type Value,
} from '@ydbjs/api/value';
import { parameterType } from '../driver/values.js';
import {
  nativeCodecConversions,
  type NativeCodecConversions,
} from './codecs.js';

export interface YqlTypeCodec {
  readonly type: Type;
  readonly input: string;
  readonly output: string;
  readonly encode: (value: unknown) => Value;
  readonly decode: (value: unknown) => unknown;
}
type Conversions = Pick<NativeCodecConversions, 'encode' | 'decode'>;
const primitiveCodecs: Partial<Record<PrimitiveId, [string, string]>> = {
  [PrimitiveId.BOOL]: ['ydb/bool@1', 'boolean'],
  [PrimitiveId.INT32]: ['ydb/int32@1', 'number'],
  [PrimitiveId.INT64]: ['ydb/int64@1', 'bigint'],
  [PrimitiveId.UINT64]: ['ydb/uint64@1', 'bigint'],
  [PrimitiveId.DOUBLE]: ['ydb/double@1', 'number'],
  [PrimitiveId.UTF8]: ['ydb/utf8@1', 'string'],
  [PrimitiveId.STRING]: ['ydb/string@1', 'Uint8Array'],
  [PrimitiveId.UUID]: ['ydb/uuid@1', 'string'],
  [PrimitiveId.DATE]: ['ydb/date@1', 'string'],
  [PrimitiveId.JSON]: ['ydb/json@1', 'JsonValue'],
  [PrimitiveId.JSON_DOCUMENT]: ['ydb/json@1', 'JsonValue'],
};
const smallNumbers: Partial<
  Record<
    PrimitiveId,
    [number, number, 'int32Value' | 'uint32Value' | 'floatValue']
  >
> = {
  [PrimitiveId.INT8]: [-128, 127, 'int32Value'],
  [PrimitiveId.INT16]: [-32768, 32767, 'int32Value'],
  [PrimitiveId.UINT8]: [0, 255, 'uint32Value'],
  [PrimitiveId.UINT16]: [0, 65535, 'uint32Value'],
  [PrimitiveId.UINT32]: [0, 4294967295, 'uint32Value'],
  [PrimitiveId.FLOAT]: [
    -3.4028234663852886e38,
    3.4028234663852886e38,
    'floatValue',
  ],
};

/** Compile both TS types and synchronous native codecs using one type grammar. */
export function compileYqlType(name: string): YqlTypeCodec {
  return compile(parameterType(name));
}
function compile(type: Type): YqlTypeCodec {
  const shape = type.type;
  let input: string, output: string, codec: Conversions;
  switch (shape.case) {
    case 'optionalType': {
      if (!shape.value.item) throw new TypeError('Missing Optional item');
      const inner = compile(shape.value.item);
      input = `${inner.input} | null | undefined`;
      output = `${inner.output} | null`;
      const nested = shape.value.item.type.case === 'optionalType';
      const nullValue = create(ValueSchema, {
        value: { case: 'nullFlagValue', value: 0 },
      });
      codec = {
        encode: (v) =>
          v == null
            ? nullValue
            : nested
              ? create(ValueSchema, {
                  value: { case: 'nestedValue', value: inner.encode(v) },
                })
              : inner.encode(v),
        decode: (v) => (v == null ? null : inner.decode(v)),
      };
      break;
    }
    case 'listType':
    case 'tupleType': {
      const isList = shape.case === 'listType';
      const children = isList
        ? [compile(shape.value.item!)]
        : shape.value.elements.map(compile);
      input = isList
        ? `ReadonlyArray<${children[0].input}>`
        : `readonly [${children.map((c) => c.input).join(', ')}]`;
      output = isList
        ? `Array<${children[0].output}>`
        : `[${children.map((c) => c.output).join(', ')}]`;
      const array = (v: unknown): unknown[] => {
        if (!Array.isArray(v) || (!isList && v.length !== children.length))
          throw new TypeError('Invalid YQL list/tuple');
        return v;
      };
      codec = {
        encode: (v) =>
          create(ValueSchema, {
            items: array(v).map((item, i) =>
              children[isList ? 0 : i].encode(item),
            ),
          }),
        decode: (v) =>
          array(v).map((item, i) => children[isList ? 0 : i].decode(item)),
      };
      break;
    }
    case 'structType': {
      const members = shape.value.members.map((m) => ({
        name: m.name,
        codec: compile(m.type!),
      }));
      for (const { name } of members)
        if (['__proto__', 'constructor', 'prototype'].includes(name))
          throw new TypeError(`Unsafe YQL struct member: ${name}`);
      const names = new Set(members.map((m) => m.name));
      input = `{ ${members.map((m) => `${JSON.stringify(m.name)}: ${m.codec.input};`).join(' ')} }`;
      output = `{ ${members.map((m) => `${JSON.stringify(m.name)}: ${m.codec.output};`).join(' ')} }`;
      const object = (v: unknown): Record<string, unknown> => {
        if (!v || typeof v !== 'object' || Array.isArray(v))
          throw new TypeError('YQL struct requires an object');
        return v as Record<string, unknown>;
      };
      codec = {
        encode: (v) => {
          const row = object(v);
          for (const key of Object.keys(row))
            if (!names.has(key))
              throw new TypeError(`Unknown YQL struct member ${key}`);
          return create(ValueSchema, {
            items: members.map(({ name, codec }) => {
              if (!Object.hasOwn(row, name))
                throw new TypeError(`Missing YQL struct member ${name}`);
              return codec.encode(row[name]);
            }),
          });
        },
        decode: (v) => {
          const row = object(v);
          const result: Record<string, unknown> = {};
          for (const { name, codec } of members) {
            if (!Object.hasOwn(row, name))
              throw new TypeError(`Missing YQL result column ${name}`);
            result[name] = codec.decode(row[name]);
          }
          return result;
        },
      };
      break;
    }
    case 'decimalType':
      input = output = 'string';
      codec = nativeCodecConversions('ydb/decimal@1', {
        precision: shape.value.precision,
        scale: shape.value.scale,
      });
      break;
    case 'typeId': {
      if (shape.value === PrimitiveId.TIMESTAMP) {
        input = 'Date | bigint | TimestampMicrosValue';
        output = 'bigint';
        const native = nativeCodecConversions('ydb/timestamp@1');
        codec = {
          encode: native.encode,
          decode: (v) => {
            if (typeof v !== 'bigint' || v < 0n || v >= 4291747200000000n)
              throw new TypeError('Invalid YQL Timestamp microseconds');
            return v;
          },
        };
        break;
      }
      const small = smallNumbers[shape.value];
      if (small) {
        input = output = 'number';
        const read = (v: unknown): number => {
          if (
            typeof v !== 'number' ||
            !Number.isFinite(v) ||
            v < small[0] ||
            v > small[1] ||
            (small[2] !== 'floatValue' && !Number.isInteger(v))
          )
            throw new TypeError(
              `Invalid YQL ${PrimitiveId[shape.value]} value`,
            );
          return v;
        };
        codec = {
          encode: (v) =>
            create(ValueSchema, { value: { case: small[2], value: read(v) } }),
          decode: read,
        };
        break;
      }
      const entry = primitiveCodecs[shape.value];
      if (!entry)
        throw new TypeError(
          `Unsupported YQL type: ${PrimitiveId[shape.value] ?? shape.value}`,
        );
      output = entry[1];
      input = output === 'bigint' ? 'bigint | number' : output;
      codec = nativeCodecConversions(entry[0]);
      break;
    }
    default:
      throw new TypeError(`Unsupported YQL type: ${shape.case}`);
  }
  return { type, input, output, ...codec };
}
