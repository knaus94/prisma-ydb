import { SqlQueryError } from '@prisma/orm-family-sql/errors';
import { create, equals } from '@bufbuild/protobuf';
import {
  TypeSchema,
  ValueSchema,
  Type_PrimitiveTypeId as PrimitiveId,
  type Column,
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
  Json,
} from '@ydbjs/value/primitive';
import type {
  YdbParameter,
  YdbQueryRequest,
  YdbSqlExecuteRequest,
} from './types.js';
import { uuidFromBigInts } from '@ydbjs/value/uuid';
import { UuidValue } from './uuid.js';
import { ydbJsonForm } from './json-form.js';

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
const jsonParameterType = /^Json\??$/;

/** Parses only the compiler's small parameter-type grammar, never SQL text. */
export function parameterType(name: string, depth = 0): Type {
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

/** Structural type equality with a cheap path for the scalar shapes codecs emit. */
function sameType(left: Type, right: Type): boolean {
  const a = left.type;
  const b = right.type;
  if (a.case !== b.case) return false;
  switch (a.case) {
    case 'typeId':
      return a.value === (b.value as PrimitiveId);
    case 'decimalType': {
      const other = b.value as typeof a.value;
      return (
        a.value.precision === other.precision && a.value.scale === other.scale
      );
    }
    case 'optionalType':
    case 'listType': {
      const inner = a.value.item;
      const other = (b.value as typeof a.value).item;
      return !!inner && !!other && sameType(inner, other);
    }
    default:
      return equals(TypeSchema, left, right);
  }
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
  if (sameType(encoded.type, expected)) return encoded;
  if (expected.type.case === 'optionalType' && sameType(encoded.type, baseType))
    return { type: expected, value: encoded.value };
  throw new SqlQueryError('YDB parameter type does not match its declaration');
}

export interface StructMember {
  readonly name: string;
  /** YQL type name in the compiler grammar, e.g. `Int32`, `Utf8?`, `Json`. */
  readonly type: string;
}

/**
 * Encode rows as one `List<Struct<...>>` for BulkUpsert. Every row supplies
 * each member as a codec value, `null` for optional members, or an array for
 * list members; members absent from a row are sent as NULL when optional.
 */
export function structList(
  members: readonly StructMember[],
  rows: readonly Readonly<Record<string, unknown>>[],
): { type: Type; value: WireValue } {
  const types = members.map((member) => parameterType(member.type));
  const struct = create(TypeSchema, {
    type: {
      case: 'structType',
      value: {
        members: members.map((member, index) => ({
          name: member.name,
          type: types[index],
        })),
      },
    },
  });
  const items = rows.map((row, position) =>
    create(ValueSchema, {
      items: members.map((member, index) => {
        const value = Object.hasOwn(row, member.name) ? row[member.name] : null;
        try {
          return typedValue(value, types[index]).value;
        } catch (error) {
          throw new SqlQueryError(
            `YDB bulk row ${position} field ${member.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    }),
  );
  return {
    type: create(TypeSchema, {
      type: { case: 'listType', value: { item: struct } },
    }),
    value: create(ValueSchema, { items }),
  };
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

const parameterName = /^\$[A-Za-z_][A-Za-z0-9_]*$/;

export function encodeParameters(
  parameters: Readonly<Record<string, YdbParameter>> = {},
) {
  const encoded: Record<string, { type: Type; value: WireValue }> =
    Object.create(null);
  for (const key in parameters) {
    const parameter = parameters[key];
    const name = key.startsWith('$') ? key : `$${key}`;
    if (!parameterName.test(name))
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

/**
 * Convert a compiled Prisma statement into a native request. Compiler metadata
 * headers are consumed here and stripped from the text sent to the server.
 */
export function sqlRequest(
  request: YdbSqlExecuteRequest,
  readTransactionMode: 'snapshotReadOnly' | 'serializable',
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
  const params = request.params ?? [];
  if (types && types.length !== params.length)
    throw new SqlQueryError(
      'YDB parameter metadata does not match parameter count',
    );
  const parameters: Record<string, YdbParameter> = Object.create(null);
  for (let index = 0; index < params.length; index++) {
    const parameter: unknown = params[index];
    const declared: unknown = types ? types[index] : undefined;
    const name = `p${index + 1}`;
    if (Array.isArray(parameter)) {
      if (typeof declared !== 'string')
        throw new SqlQueryError(
          'Array YDB parameters require compiler type metadata',
        );
      const value = jsonParameterType.test(declared)
        ? new Json(
            JSON.stringify(
              parameter.map((element: unknown) => {
                if (
                  typeof element !== 'object' ||
                  element === null ||
                  !(ydbJsonForm in element) ||
                  typeof element[ydbJsonForm] !== 'function'
                )
                  throw new SqlQueryError(
                    'YDB list columns require non-null codec-encoded elements',
                  );
                return element[ydbJsonForm]();
              }),
            ),
          )
        : parameter;
      parameters[name] = typedValue(
        value,
        declaredType(header, index, declared),
      );
    } else if (isParameter(parameter)) {
      parameters[name] =
        typeof declared === 'string'
          ? typedValue(parameter, declaredType(header, index, declared))
          : parameter;
    } else if (parameter === null) {
      if (typeof declared !== 'string' || !declared.endsWith('?')) {
        throw new SqlQueryError(
          'Null YDB parameters require compiler-supplied optional type metadata',
        );
      }
      parameters[name] = typedValue(
        null,
        declaredType(header, index, declared),
      );
    } else {
      // Prisma may supply pagination/structural values without a field codec. The
      // compiler declares their type, so convert only checked matching primitives.
      const optional = typeof declared === 'string' && declared.endsWith('?');
      const baseType =
        typeof declared === 'string'
          ? optional
            ? declared.slice(0, -1)
            : declared
          : undefined;
      const value = plainValue(baseType, parameter);
      if (!value)
        throw new SqlQueryError(
          `YDB parameter ${name} must be encoded by a YDB codec`,
        );
      parameters[name] = optional ? new Optional(value) : value;
    }
  }
  const compiledSelect = countMode === 'none';
  return {
    text: header.body ?? request.sql,
    parameters,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
    // Compiler-tagged SELECTs are read-only and replay-safe; they follow the
    // configured read mode. Mutations keep the serializable default.
    transactionMode: compiledSelect ? readTransactionMode : undefined,
    idempotent: compiledSelect,
    affectedRows:
      affectedRows && countMode === 'returning' ? 'returning' : undefined,
  };
}

function plainValue(baseType: string | undefined, parameter: unknown) {
  switch (baseType) {
    case 'Int64':
    case 'Uint64': {
      if (
        typeof parameter !== 'bigint' &&
        !(typeof parameter === 'number' && Number.isSafeInteger(parameter))
      )
        return undefined;
      const integer = BigInt(parameter);
      if (baseType === 'Int64')
        return integer >= -(1n << 63n) && integer < 1n << 63n
          ? new Int64(integer)
          : undefined;
      return integer >= 0n && integer < 1n << 64n
        ? new Uint64(integer)
        : undefined;
    }
    case 'Int32':
      return typeof parameter === 'number' &&
        Number.isInteger(parameter) &&
        parameter >= -2147483648 &&
        parameter <= 2147483647
        ? new Int32(parameter)
        : undefined;
    case 'Double':
      return typeof parameter === 'number' && Number.isFinite(parameter)
        ? new Double(parameter)
        : undefined;
    case 'Utf8':
      return typeof parameter === 'string' ? new Text(parameter) : undefined;
    case 'Uuid':
      return typeof parameter === 'string'
        ? new UuidValue(parameter)
        : undefined;
    case 'Bool':
      return typeof parameter === 'boolean' ? new Bool(parameter) : undefined;
    default:
      return undefined;
  }
}

type Projector = (row: Record<string, unknown>) => Record<string, unknown>;

interface Header {
  /** Statement text without metadata comments; undefined for untagged SQL. */
  body?: string;
  types?: unknown[];
  parameterTypes: (Type | undefined)[];
  countMode?: string;
  project?: Projector;
}
const emptyHeader: Header = Object.freeze({ parameterTypes: [] });
Object.freeze(emptyHeader.parameterTypes);
const headerPrefix = '-- prisma-ydb-';
const headerLimit = 64 * 1024;
const headerCacheSize = 2048;
const headerCache = new Map<string, Header>();

/** Parse (and cache by text) the compiler's leading metadata comments. */
function parseHeader(sql: string): Header {
  if (!sql.startsWith(headerPrefix)) return emptyHeader;
  const cached = headerCache.get(sql);
  if (cached) {
    headerCache.delete(sql);
    headerCache.set(sql, cached);
    return cached;
  }
  const header: Header = { parameterTypes: [] };
  let offset = 0;
  while (sql.startsWith(headerPrefix, offset)) {
    const end = sql.indexOf('\n', offset);
    if (end < 0 || end > headerLimit)
      throw new SqlQueryError('Invalid YDB statement metadata');
    const line = sql.slice(offset, end);
    offset = end + 1;
    if (line.startsWith(paramTypesPrefix)) {
      const types = parseJson(line.slice(paramTypesPrefix.length), 'parameter');
      if (!Array.isArray(types))
        throw new SqlQueryError(
          'YDB parameter metadata does not match parameter count',
        );
      header.types = types;
    } else if (line.startsWith(affectedRowsPrefix))
      header.countMode = line.slice(affectedRowsPrefix.length);
    else if (line.startsWith(resultColumnsPrefix)) {
      const value = parseJson(
        line.slice(resultColumnsPrefix.length),
        'projection',
      );
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
      header.project = projector(value as [string, string][]);
    }
  }
  header.body = sql.slice(offset);
  if (sql.length <= headerLimit) {
    headerCache.set(sql, header);
    if (headerCache.size > headerCacheSize) {
      const oldest = headerCache.keys().next().value;
      if (oldest !== undefined) headerCache.delete(oldest);
    }
  }
  return header;
}
const paramTypesPrefix = '-- prisma-ydb-param-types: ';
const affectedRowsPrefix = '-- prisma-ydb-affected-rows: ';
const resultColumnsPrefix = '-- prisma-ydb-result-columns: ';

function parseJson(text: string, kind: 'parameter' | 'projection'): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new SqlQueryError(`Invalid YDB ${kind} metadata`);
  }
}

function projector(projections: readonly [string, string][]): Projector {
  return (row) => {
    const result: Record<string, unknown> = Object.create(null);
    for (const [alias, column] of projections) {
      if (!(column in row))
        throw new SqlQueryError(
          'YDB RETURNING did not include a requested column',
        );
      if (alias in result)
        throw new SqlQueryError('YDB projection aliases must be unique');
      result[alias] = row[column];
    }
    return result;
  };
}

function declaredType(header: Header, index: number, name: string): Type {
  return (header.parameterTypes[index] ??= parameterType(name));
}

export function isCompilerSelect(sql: string): boolean {
  return parseHeader(sql).countMode === 'none';
}

const identity: Projector = (row) => row;

export function rowProjector(sql: string): Projector {
  return parseHeader(sql).project ?? identity;
}

type Decoder = (value: WireValue) => unknown;

function invalid(message: string): never {
  throw new SqlQueryError(message);
}

/**
 * Build a decoder for one column type once per result set. SDK 6 does not
 * decode decimal or extended date primitives, so their precision is preserved.
 */
export function columnDecoder(type: Type): Decoder {
  const shape = type.type;
  switch (shape.case) {
    case 'optionalType': {
      const item = shape.value.item;
      if (!item) invalid('YDB returned an optional without an item type');
      const inner = columnDecoder(item);
      return (value) => {
        const wrapped = value.value;
        if (wrapped.case === 'nullFlagValue') return null;
        return inner(wrapped.case === 'nestedValue' ? wrapped.value : value);
      };
    }
    case 'decimalType': {
      const scale = shape.value.scale;
      return (value) => {
        if (value.value.case !== 'low128')
          invalid('YDB returned an invalid Decimal value');
        const signed = BigInt.asIntN(
          128,
          (value.high128 << 64n) | value.value.value,
        );
        const magnitude = signed < 0n ? -signed : signed;
        // YDB reserves 10^35 and greater for non-finite values.
        if (magnitude >= decimalLimit)
          invalid('Non-finite YDB Decimal is unsupported');
        const digits = magnitude.toString().padStart(scale + 1, '0');
        return `${signed < 0n ? '-' : ''}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
      };
    }
    case 'listType': {
      const item = shape.value.item;
      if (!item) invalid('YDB returned a list without an item type');
      const inner = columnDecoder(item);
      return (value) => value.items.map(inner);
    }
    case 'structType': {
      const members = shape.value.members.map((member) => {
        if (!member.type) invalid('Invalid YDB struct value');
        return { name: member.name, decode: columnDecoder(member.type) };
      });
      return (value) => {
        const object: Record<string, unknown> = Object.create(null);
        for (let index = 0; index < members.length; index++) {
          const item = value.items[index];
          if (!item) invalid('Invalid YDB struct value');
          object[members[index].name] = members[index].decode(item);
        }
        return object;
      };
    }
    case 'typeId':
      switch (shape.value) {
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
          return (value) => value.value.value;
        case PrimitiveId.UUID:
          return (value) => {
            if (value.value.case !== 'low128')
              invalid('YDB returned an invalid Uuid value');
            return uuidFromBigInts(value.value.value, value.high128);
          };
        case PrimitiveId.JSON:
        case PrimitiveId.JSON_DOCUMENT:
          return (value) => JSON.parse(value.value.value as string);
      }
      break;
  }
  return (value) => toJs(fromYdb(value, type));
}

/** One-off decode; result-set paths use columnDecoder to amortize type dispatch. */
export function decodeValue(value: WireValue, type: Type): unknown {
  return columnDecoder(type)(value);
}

export interface RowPlan {
  readonly names: readonly string[];
  readonly decoders: readonly Decoder[];
  /** Fixed per-row overhead: object header plus column-name keys. */
  readonly baseSize: number;
}

/** Validate columns and build the per-column decoders for one result set. */
export function rowPlan(columns: readonly Column[], wire: boolean): RowPlan {
  const names: string[] = [];
  const decoders: Decoder[] = [];
  let baseSize = 32;
  for (const column of columns) {
    const type = column.type;
    if (!type) invalid('YDB returned an invalid row');
    if (names.includes(column.name))
      invalid('YDB returned duplicate column names; use aliases');
    names.push(column.name);
    decoders.push(wire ? passthrough : columnDecoder(type));
    baseSize += column.name.length;
  }
  return { names, decoders, baseSize };
}
const passthrough: Decoder = (value) => value;

/** Cheap memory estimate for result bounding; string cost is by length, not bytes. */
export function estimateRowSize(
  row: Record<string, unknown>,
  plan: RowPlan,
): number {
  let size = plan.baseSize;
  for (const name of plan.names) size += estimateSize(row[name]);
  return size;
}

export function estimateSize(value: unknown): number {
  if (value === null || value === undefined) return 4;
  switch (typeof value) {
    case 'string':
      return value.length + 8;
    case 'object':
      break;
    default:
      return 16;
  }
  if (value instanceof Uint8Array) return value.byteLength + 16;
  if (value instanceof Date) return 16;
  if (Array.isArray(value)) {
    let size = 24;
    for (const item of value) size += estimateSize(item);
    return size;
  }
  if (value instanceof Map) {
    let size = 32;
    for (const [key, item] of value)
      size += estimateSize(key) + estimateSize(item);
    return size;
  }
  let size = 32;
  for (const key in value as Record<string, unknown>)
    size += key.length + estimateSize((value as Record<string, unknown>)[key]);
  return size;
}

export type YdbValue = Value;

const decimalLimit = 10n ** 35n;
