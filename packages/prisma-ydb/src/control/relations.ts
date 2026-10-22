import {
  StorageTable,
  type SqlNamespaceInput,
} from '@prisma/orm-family-sql/contract/types';
import { ydbCreateNamespace, type YdbNamespace } from './contract.js';

/**
 * PSL authoring hook: keep ORM relations and lookup indexes, but do not put
 * unsupported SQL foreign keys into YDB's physical schema. Used only when
 * application-managed relations are explicitly selected in the CLI config.
 * Action-bearing keys are client metadata; keys without actions stay absent.
 */
export function ydbCreateApplicationRelationsNamespace(
  input: SqlNamespaceInput,
): YdbNamespace {
  const namespace = ydbCreateNamespace(input);
  const tables = Object.fromEntries(
    Object.entries(namespace.table).map(([name, table]) => {
      if (table.foreignKeys.length === 0) return [name, table];
      for (const key of table.foreignKeys) {
        if (
          (key.onDelete !== undefined || key.onUpdate !== undefined) &&
          (key.onDelete === undefined || key.onDelete === 'noAction') &&
          (key.onUpdate === undefined || key.onUpdate === 'noAction')
        )
          throw new Error(
            `YDB client-side NoAction is equivalent to Restrict (${name}). Declare onDelete: Restrict (or Cascade/SetNull) to opt in to enforcement; omit referential actions to keep the relation unenforced. Prisma 8 canonicalization omits NoAction-only metadata.`,
          );
      }
      return [
        name,
        new StorageTable({
          ...table,
          foreignKeys: table.foreignKeys.filter(
            (key) => key.onDelete !== undefined || key.onUpdate !== undefined,
          ),
        }),
      ];
    }),
  );
  return ydbCreateNamespace({
    id: namespace.id,
    entries: { ...namespace.entries, table: tables },
  });
}
