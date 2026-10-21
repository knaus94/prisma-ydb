import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { SqlQueryError } from '@prisma/orm-family-sql/errors';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import {
  Entry_Type,
  ListDirectoryResultSchema,
  SchemeServiceDefinition,
} from '@ydbjs/api/scheme';
import type { Driver } from '@ydbjs/core';
import { YDBError } from '@ydbjs/error';
import { deadline } from './abort.js';
import { normalizeError } from './errors.js';

/**
 * Authoritative row-table existence check through SchemeService. Absence is
 * decided from directory entries, never from query error text.
 */
export async function ydbTableExists(
  core: Driver,
  name: string,
  timeoutMs = 30_000,
): Promise<boolean> {
  const client = core.createClient(SchemeServiceDefinition);
  const segments = name.split('/');
  let path = core.database;
  for (const [index, segment] of segments.entries()) {
    const scope = deadline(timeoutMs);
    let entries;
    try {
      const response = await client.listDirectory(
        { path },
        { signal: scope.signal },
      );
      const operation = response.operation;
      if (!operation?.ready || operation.status !== Status.SUCCESS)
        throw new YDBError(
          operation?.status ?? Status.STATUS_CODE_UNSPECIFIED,
          operation?.issues ?? [],
        );
      const result = operation.result
        ? anyUnpack(operation.result, ListDirectoryResultSchema)
        : undefined;
      if (!result)
        throw new SqlQueryError('YDB returned an invalid ListDirectory result');
      entries = result.children;
    } catch (error) {
      throw normalizeError(error, 'list directory');
    } finally {
      scope.dispose();
    }
    const entry = entries.find((child) => child.name === segment);
    if (!entry) return false;
    if (index === segments.length - 1) {
      if (
        entry.type === Entry_Type.COLUMN_TABLE ||
        entry.type === Entry_Type.COLUMN_STORE
      )
        throw new Error(
          `YDB column-oriented object ${name} cannot be represented by this row-table contract.`,
        );
      return entry.type === Entry_Type.TABLE;
    }
    if (entry.type !== Entry_Type.DIRECTORY || segment.startsWith('.'))
      return false;
    path += `/${segment}`;
  }
  return true;
}
