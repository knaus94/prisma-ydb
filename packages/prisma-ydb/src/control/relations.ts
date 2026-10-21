import {
  StorageTable,
  type SqlNamespaceInput,
} from '@prisma/orm-family-sql/contract/types';
import { ydbCreateNamespace, type YdbNamespace } from './contract.js';

/**
 * PSL authoring hook: keep ORM relations and lookup indexes, but do not put
 * unsupported SQL foreign keys into YDB's physical schema. Used only when
 * application-managed relations are explicitly selected in the CLI config.
 * Deserialization deliberately keeps using the strict namespace factory.
 */
export function ydbCreateApplicationRelationsNamespace(
  input: SqlNamespaceInput,
): YdbNamespace {
  const namespace = ydbCreateNamespace(input);
  const tables = Object.fromEntries(
    Object.entries(namespace.table).map(([name, table]) => {
      if (table.foreignKeys.length === 0) return [name, table];
      for (const key of table.foreignKeys) {
        // Never silently discard requested cascades or constraint checks.
        if (key.onDelete !== undefined || key.onUpdate !== undefined) {
          throw new Error(
            `YDB application relations do not enforce onDelete/onUpdate (${name}). Remove the referential action and implement it explicitly in a transaction.`,
          );
        }
      }
      return [name, new StorageTable({ ...table, foreignKeys: [] })];
    }),
  );
  return ydbCreateNamespace({
    id: namespace.id,
    entries: { ...namespace.entries, table: tables },
  });
}
