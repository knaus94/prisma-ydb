import { Json } from '@ydbjs/value/primitive';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import { structList, type StructMember } from '../driver/values.js';
import type { YdbDriver } from '../driver/driver.js';
import { encodeYdbJson, encodeYdbValue, yqlTypeForCodec } from './codecs.js';
import { resolveModel, type ModelColumn } from './model.js';

export interface YdbBulkUpsertOptions {
  /** Rows per BulkUpsert RPC; chunks are sent sequentially and retried individually. */
  readonly chunkSize?: number;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface YdbBulkUpsertResult {
  readonly rows: number;
  readonly chunks: number;
}

function memberType(column: ModelColumn): string {
  const base = column.many
    ? 'Json'
    : yqlTypeForCodec(column.codecId, column.typeParams);
  return column.nullable ? `${base}?` : base;
}

function encodeField(column: ModelColumn, value: unknown): unknown {
  if (value === null || value === undefined) {
    if (!column.nullable)
      throw new TypeError(`${column.field} is required and cannot be null`);
    return null;
  }
  if (column.many) {
    if (!Array.isArray(value))
      throw new TypeError(`${column.field} is a list and requires an array`);
    return new Json(
      JSON.stringify(
        value.map((element) => {
          if (element === null || element === undefined)
            throw new TypeError(`${column.field} list elements cannot be null`);
          return encodeYdbJson(column.codecId, element, column.typeParams);
        }),
      ),
    );
  }
  return encodeYdbValue(column.codecId, value, column.typeParams);
}

/**
 * Encode model rows through the contract codecs and write them with
 * TableService BulkUpsert. Unlike ORM writes this bypasses temporal presets,
 * referential actions and transactions: it is an idempotent, chunked upload.
 */
export async function bulkUpsertModel(
  driver: YdbDriver,
  contract: Contract<SqlStorage>,
  modelName: string,
  rows: readonly Readonly<Record<string, unknown>>[],
  options: YdbBulkUpsertOptions = {},
): Promise<YdbBulkUpsertResult> {
  const chunkSize = options.chunkSize ?? 1000;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1)
    throw new TypeError('chunkSize must be a positive integer');
  if (!rows.length) return { rows: 0, chunks: 0 };
  const model = resolveModel(contract, modelName);
  // One struct type for the whole upload: the union of supplied fields; the
  // primary key is mandatory, other absent fields are sent as NULL when nullable.
  // Column tables require every column in each BulkUpsert row.
  const present = new Set<string>(
    model.options.store?.kind === 'column'
      ? model.columns.map((column) => column.field)
      : model.primaryKey.map((key) => key.field),
  );
  for (const row of rows)
    for (const field of Object.keys(row)) {
      if (!model.byField.has(field))
        throw new TypeError(`Unknown field ${field} on YDB model ${modelName}`);
      present.add(field);
    }
  const members: StructMember[] = [];
  const columns: ModelColumn[] = [];
  for (const column of model.columns)
    if (present.has(column.field)) {
      columns.push(column);
      members.push({ name: column.column, type: memberType(column) });
    }
  const encoded = rows.map((row, index) => {
    const struct: Record<string, unknown> = Object.create(null);
    for (const column of columns) {
      const value = row[column.field];
      if (
        (value === undefined || value === null) &&
        model.primaryKey.includes(column)
      )
        throw new TypeError(
          `Row ${index} lacks primary key field ${column.field}`,
        );
      try {
        struct[column.column] = encodeField(column, value);
      } catch (error) {
        throw new TypeError(
          `Row ${index}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return struct;
  });
  let chunks = 0;
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    await driver.bulkUpsert({
      table: model.table,
      rows: structList(members, encoded.slice(offset, offset + chunkSize)),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    chunks++;
  }
  return { rows: encoded.length, chunks };
}
