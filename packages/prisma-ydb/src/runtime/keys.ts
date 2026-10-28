import type { StorageTable } from '@prisma/orm-family-sql/contract/types';

/**
 * How YDB can look `columns` up on `table`: `'primary'` when they prefix the
 * primary key, the name of a secondary index they prefix, or undefined when
 * only a scan remains. Equality on a key prefix is what makes lookups cheap.
 */
export function keyPathFor(
  table: StorageTable | undefined,
  columns: readonly string[],
): string | undefined {
  if (!table || !columns.length) return undefined;
  if (
    columns.every(
      (column, index) => table.primaryKey?.columns[index] === column,
    )
  )
    return 'primary';
  return table.indexes.find(
    (index) =>
      !index.where &&
      columns.every((column, position) => index.columns?.[position] === column),
  )?.name;
}

/** The secondary index to read through, if lookups need one at all. */
export function lookupIndex(
  table: StorageTable | undefined,
  columns: readonly string[],
): string | undefined {
  const path = keyPathFor(table, columns);
  return path === 'primary' ? undefined : path;
}
