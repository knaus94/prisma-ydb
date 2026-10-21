import { SqlQueryError } from '@prisma/orm-family-sql/errors';
import { create, equals } from '@bufbuild/protobuf';
import {
  TypeSchema,
  ValueSchema,
  Type_PrimitiveTypeId as PrimitiveId,
  type Type,
  type Value as WireValue,
} from '@ydbjs/api/value';
import { fromYdb, toJs, type Value } from '@ydbjs/value';
import { Optional } from '@ydbjs/value/optional';
import {
  Bool,
  Double,
  Int32,
  Int64,
  PrimitiveType,
  Text,
  Uint64,
} from '@ydbjs/value/primitive';
import type {
  YdbParameter,
  YdbQueryRequest,
  YdbSqlExecuteRequest,
} from './types.js';

const primitiveTypes: Record<string, PrimitiveId> = {
  Bool: PrimitiveId.BOOL,
  Int8: PrimitiveId.INT8,
  Int16: PrimitiveId.INT16,
  Int32: PrimitiveId.INT32,
  Int64: PrimitiveId.INT64,
  Uint8: PrimitiveId.UINT8,
  Uint16: PrimitiveId.UINT16,
  Uint32: PrimitiveId.UINT32,
  Uint64: PrimitiveId.UINT64,
  Float: PrimitiveId.FLOAT,
  Double: PrimitiveId.DOUBLE,
  String: PrimitiveId.STRING,
  Utf8: PrimitiveId.UTF8,
  Json: PrimitiveId.JSON,
  JsonDocument: PrimitiveId.JSON_DOCUMENT,
  Date: PrimitiveId.DATE,
  Datetime: PrimitiveId.DATETIME,
  Timestamp: PrimitiveId.TIMESTAMP,
  Interval: PrimitiveId.INTERVAL,
  Uuid: PrimitiveId.UUID,
};

/** Parses only the compiler's small parameter-type grammar, never SQL text. */
function parameterType(name: string, depth = 0): Type {
  if (depth > 8 || name.length > 256)
    throw new SqlQueryError('YDB parameter type metadata is too deeply nested');
  if (name.endsWith('?'))
    return create(TypeSchema, {
      type: {
        case: 'optionalType',
        value: { item: parameterType(name.slice(0, -1), depth + 1) },
      },
    });
  if (name.startsWith('List<') && name.endsWith('>'))
    return create(TypeSchema, {
      type: {
        case: 'listType',
        value: { item: parameterType(name.slice(5, -1), depth + 1) },
      },
    });
  if (Object.hasOwn(primitiveTypes, name))
    return new PrimitiveType(primitiveTypes[name]).encode();
  const decimal = /^Decimal\(([1-9]\d?),\s*(\d{1,2})\)$/.exec(name);
  if (decimal) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    if (precision <= 35 && scale <= precision)
      return create(TypeSchema, {
        type: { case: 'decimalType', value: { precision, scale } },
      });
  }
  throw new SqlQueryError(
    'YDB parameter type metadata is unsupported or invalid',
  );
}

function typedValue(
  parameter: unknown,
  expected: Type,
): { type: Type; value: WireValue } {
  if (parameter === null) {
    if (expected.type.case !== 'optionalType')
      throw new SqlQueryError('Null YDB values require an Optional type');
    return {
      type: expected,
      value: create(ValueSchema, {
        value: { case: 'nullFlagValue', value: 0 },
      }),
    };
  }
  const baseType =
    expected.type.case === 'optionalType' ? expected.type.value.item : expected;
  if (!baseType)
    throw new SqlQueryError('YDB Optional type requires an item type');
  if (Array.isArray(parameter)) {
    if (baseType.type.case !== 'listType' || !baseType.type.value.item)
      throw new SqlQueryError('Array YDB values require a List type');
    const itemType = baseType.type.value.item;
    return {
      type: expected,
      value: create(ValueSchema, {
        items: parameter.map((item) => typedValue(item, itemType).value),
      }),
    };
  }
  if (!isParameter(parameter))
    throw new SqlQueryError('YDB list items require explicitly encoded values');
  const encoded =
    'encode' in parameter
      ? { type: parameter.type.encode(), value: parameter.encode() }
      : parameter;
  if (equals(TypeSchema, encoded.type, expected)) return encoded;
  if (
    expected.type.case === 'optionalType' &&
    equals(TypeSchema, encoded.type, baseType)
  ) {
    return { type: expected, value: encoded.value };
  }
  throw new SqlQueryError('YDB parameter type does not match its declaration');
}

export function isParameter(value: unknown): value is YdbParameter {
  return (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    (('encode' in value && typeof value.encode === 'function') ||
      'value' in value)
  );
}

export function encodeParameters(
  parameters: Readonly<Record<string, YdbParameter>> = {},
) {
  const encoded: Record<string, { type: Type; value: WireValue }> =
    Object.create(null);
  for (const [key, parameter] of Object.entries(parameters)) {
    const name = key.startsWith('$') ? key : `$${key}`;
    if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      throw new SqlQueryError('Invalid YDB parameter name');
    if (name in encoded)
      throw new SqlQueryError(`Duplicate YDB parameter ${name}`);
    if (!isParameter(parameter))
      throw new SqlQueryError(
        `YDB parameter ${name} must have an explicit type`,
      );
    encoded[name] =
      'encode' in parameter
        ? { type: parameter.type.encode(), value: parameter.encode() }
        : { type: parameter.type, value: parameter.value };
  }
  return encoded;
}

export function sqlRequest(
  request: YdbSqlExecuteRequest,
  affectedRows = false,
): YdbQueryRequest {
  const header = parseHeader(request.sql);
  const countMode = header.countMode;
  if (affectedRows && countMode !== 'returning' && countMode !== 'none') {
    throw new SqlQueryError(
      'YDB execute requires a compiler-declared affected-row strategy; use native executeYql for raw statements',
    );
  }
  const types = header.types;
  if (types && types.length !== (request.params?.length ?? 0))
    throw new SqlQueryError(
      'YDB parameter metadata does not match parameter count',
    );
  const parameters: Record<string, YdbParameter> = Object.create(null);
  for (const [index, parameter] of (request.params ?? []).entries()) {
    const declared: unknown = Array.isArray(types) ? types[index] : undefined;
    if (Array.isArray(parameter)) {
      if (typeof declared !== 'string')
        throw new SqlQueryError(
          'Array YDB parameters require compiler type metadata',
        );
      parameters[`p${index + 1}`] = typedValue(
        parameter,
        declaredType(header, index, declared),
      );
    } else if (isParameter(parameter)) {
      parameters[`p${index + 1}`] =
        typeof declared === 'string'
          ? typedValue(parameter, declaredType(header, index, declared))
          : parameter;
    } else if (parameter === null) {
      const name: unknown = Array.isArray(types) ? types[index] : undefined;
      if (typeof name !== 'string' || !name.endsWith('?')) {
        throw new SqlQueryError(
          'Null YDB parameters require compiler-supplied optional type metadata',
        );
      }
      parameters[`p${index + 1}`] = typedValue(
        null,
        declaredType(header, index, name),
      );
    } else {
      // Prisma may supply pagination/structural values without a field codec. The
      // compiler declares their type, so convert only checked matching primitives.
      const name: unknown = Array.isArray(types) ? types[index] : undefined;
      const baseType =
        typeof name === 'string' ? name.replace(/\?$/, '') : undefined;
      let value: Value | undefined;
      if (
        baseType === 'Int64' &&
        (typeof parameter === 'bigint' ||
          (typeof parameter === 'number' && Number.isSafeInteger(parameter)))
      ) {
        const integer = BigInt(parameter);
        if (integer >= -(1n << 63n) && integer < 1n << 63n)
          value = new Int64(integer);
      } else if (
        baseType === 'Uint64' &&
        (typeof parameter === 'bigint' ||
          (typeof parameter === 'number' && Number.isSafeInteger(parameter)))
      ) {
        const integer = BigInt(parameter);
        if (integer >= 0n && integer < 1n << 64n) value = new Uint64(integer);
      } else if (
        baseType === 'Int32' &&
        typeof parameter === 'number' &&
        Number.isInteger(parameter) &&
        parameter >= -2147483648 &&
        parameter <= 2147483647
      )
        value = new Int32(parameter);
      else if (
        baseType === 'Double' &&
        typeof parameter === 'number' &&
        Number.isFinite(parameter)
      )
        value = new Double(parameter);
      else if (baseType === 'Utf8' && typeof parameter === 'string')
        value = new Text(parameter);
      else if (baseType === 'Bool' && typeof parameter === 'boolean')
        value = new Bool(parameter);
      if (!value)
        throw new SqlQueryError(
          `YDB parameter p${index + 1} must be encoded by a YDB codec`,
        );
      parameters[`p${index + 1}`] =
        typeof declared === 'string' && declared.endsWith('?')
          ? new Optional(value)
          : value;
    }
  }
  return {
    text: request.sql,
    parameters,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    // Compiler-tagged SELECTs are read-only; the connection picks the read mode.
    idempotent: countMode === 'none',
    affectedRows:
      affectedRows && countMode === 'returning' ? 'returning' : undefined,
  };
}

interface Header {
  types?: unknown[];
  parameterTypes: (Type | undefined)[];
  countMode?: string;
  projections?: [string, string][];
}
const emptyHeader: Header = Object.freeze({ parameterTypes: [] });
Object.freeze(emptyHeader.parameterTypes);
const headerCache = new Map<string, Header>();
function parseHeader(sql: string): Header {
  if (!sql.startsWith('-- prisma-ydb-')) return emptyHeader;
  const cached = headerCache.get(sql);
  if (cached) {
    headerCache.delete(sql);
    headerCache.set(sql, cached);
    return cached;
  }
  const lines = sql.slice(0, 64 * 1024).split('\n');
  const leading: string[] = [];
  for (const line of lines) {
    if (!line.startsWith('-- prisma-ydb-')) break;
    leading.push(line);
  }
  const header: Header = { parameterTypes: [] };
  header.countMode = leading
    .find((line) => line.startsWith('-- prisma-ydb-affected-rows: '))
    ?.slice('-- prisma-ydb-affected-rows: '.length);
  const prefix = '-- prisma-ydb-param-types: ';
  if (sql.startsWith(prefix)) {
    const end = sql.indexOf('\n');
    if (end < 0 || end > 64 * 1024)
      throw new SqlQueryError('Invalid YDB parameter metadata');
    let types: unknown;
    try {
      types = JSON.parse(sql.slice(prefix.length, end));
    } catch {
      throw new SqlQueryError('Invalid YDB parameter metadata');
    }
    if (!Array.isArray(types))
      throw new SqlQueryError(
        'YDB parameter metadata does not match parameter count',
      );
    header.types = types;
  }
  const projection = leading.find((line) =>
    line.startsWith('-- prisma-ydb-result-columns: '),
  );
  if (projection) {
    let value: unknown;
    try {
      value = JSON.parse(
        projection.slice('-- prisma-ydb-result-columns: '.length),
      );
    } catch {
      throw new SqlQueryError('Invalid YDB projection metadata');
    }
    if (
      !Array.isArray(value) ||
      !value.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          entry.every((name) => typeof name === 'string'),
      )
    )
      throw new SqlQueryError('Invalid YDB projection metadata');
    header.projections = value;
  }
  if (sql.length <= 64 * 1024) {
    headerCache.set(sql, header);
    if (headerCache.size > 256) {
      const oldest = headerCache.keys().next().value;
      if (oldest !== undefined) headerCache.delete(oldest);
    }
  }
  return header;
}

function declaredType(header: Header, index: number, name: string): Type {
  return (header.parameterTypes[index] ??= parameterType(name));
}

export function isCompilerSelect(sql: string): boolean {
  return parseHeader(sql).countMode === 'none';
}

export function projectRow(
  row: Record<string, unknown>,
  sql: string,
): Record<string, unknown> {
  return rowProjector(sql)(row);
}

export function rowProjector(
  sql: string,
): (row: Record<string, unknown>) => Record<string, unknown> {
  const projections = parseHeader(sql).projections;
  if (!projections) return (row) => row;
  return (row) => {
    const result: Record<string, unknown> = Object.create(null);
    for (const [alias, column] of projections as [string, string][]) {
      if (!Object.hasOwn(row, column))
        throw new SqlQueryError(
          'YDB RETURNING did not include a requested column',
        );
      if (Object.hasOwn(result, alias))
        throw new SqlQueryError('YDB projection aliases must be unique');
      result[alias] = row[column];
    }
    return result;
  };
}

/** SDK 6 does not decode decimal or extended date primitives. Preserve their precision. */
export function decodeValue(value: WireValue, type: Type): unknown {
  if (type.type.case === 'optionalType') {
    if (value.value.case === 'nullFlagValue') return null;
    if (!type.type.value.item)
      throw new SqlQueryError('YDB returned an optional without an item type');
    return decodeValue(
      value.value.case === 'nestedValue' ? value.value.value : value,
      type.type.value.item,
    );
  }
  if (type.type.case === 'decimalType') {
    if (value.value.case !== 'low128')
      throw new SqlQueryError('YDB returned an invalid Decimal value');
    const signed = BigInt.asIntN(
      128,
      (value.high128 << 64n) | value.value.value,
    );
    const magnitude = signed < 0n ? -signed : signed;
    // YDB reserves 10^35 and greater for non-finite values.
    if (magnitude >= decimalLimit)
      throw new SqlQueryError('Non-finite YDB Decimal is unsupported');
    const scale = type.type.value.scale;
    const digits = magnitude.toString().padStart(scale + 1, '0');
    return `${signed < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
  }
  if (type.type.case === 'listType') {
    const item = type.type.value.item;
    if (!item)
      throw new SqlQueryError('YDB returned a list without an item type');
    return value.items.map((entry) => decodeValue(entry, item));
  }
  if (type.type.case === 'structType') {
    const object: Record<string, unknown> = Object.create(null);
    for (const [index, member] of type.type.value.members.entries()) {
      if (!member.type || !value.items[index])
        throw new SqlQueryError('Invalid YDB struct value');
      object[member.name] = decodeValue(value.items[index], member.type);
    }
    return object;
  }
  if (type.type.case === 'typeId') {
    switch (type.type.value) {
      case PrimitiveId.BOOL:
      case PrimitiveId.INT8:
      case PrimitiveId.INT16:
      case PrimitiveId.INT32:
      case PrimitiveId.UINT8:
      case PrimitiveId.UINT16:
      case PrimitiveId.UINT32:
      case PrimitiveId.INT64:
      case PrimitiveId.UINT64:
      case PrimitiveId.FLOAT:
      case PrimitiveId.DOUBLE:
      case PrimitiveId.UTF8:
      case PrimitiveId.STRING:
      case PrimitiveId.TIMESTAMP:
      case PrimitiveId.TIMESTAMP64:
      case PrimitiveId.INTERVAL:
      case PrimitiveId.INTERVAL64:
        return value.value.value;
      case PrimitiveId.JSON:
      case PrimitiveId.JSON_DOCUMENT:
        return JSON.parse(value.value.value as string);
    }
  }
  return toJs(fromYdb(value, type));
}

export function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 4;
  if (typeof value === 'string') return Buffer.byteLength(value) + 8;
  if (value instanceof Uint8Array) return value.byteLength + 16;
  if (value instanceof Date) return 16;
  if (typeof value !== 'object') return 16;
  if (value instanceof Map)
    return [...value].reduce((size, entry) => size + estimateSize(entry), 32);
  if (Array.isArray(value))
    return value.reduce((size, item) => size + estimateSize(item), 24);
  return Object.entries(value).reduce(
    (size, [key, item]) => size + Buffer.byteLength(key) + estimateSize(item),
    32,
  );
}

export type YdbValue = Value;

const decimalLimit = 10n ** 35n;
