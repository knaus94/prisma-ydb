import type { Contract } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import type { YdbDriver } from '../driver/driver.js';
import {
  resolveModel,
  compileModelRowEncoder,
  type ModelColumn,
} from './model.js';

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
    for (const field in row) {
      if (!Object.hasOwn(row, field)) continue;
      if (!model.byField.has(field))
        throw new TypeError(`Unknown field ${field} on YDB model ${modelName}`);
      present.add(field);
    }
  const columns: ModelColumn[] = [];
  for (const column of model.columns)
    if (present.has(column.field)) {
      columns.push(column);
    }
  const encoder = compileModelRowEncoder(columns, model.primaryKey);
  const encoded = rows.map((row, index) => encoder.row(row, index));
  let chunks = 0;
  for (let offset = 0; offset < encoded.length; offset += chunkSize) {
    await driver.bulkUpsert({
      table: model.table,
      rows: encoder.list(encoded.slice(offset, offset + chunkSize)),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
    chunks++;
  }
  return { rows: encoded.length, chunks };
}
