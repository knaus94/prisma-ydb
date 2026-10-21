import type { Contract } from '@prisma/orm-framework/contract/types';
import {
  UNBOUND_NAMESPACE_ID,
  hydrateNamespaceEntities,
} from '@prisma/orm-framework/components/ir';
import { tableEntityKind } from '@prisma/orm-family-sql/contract/entity-kinds';
import { SqlContractSerializerBase } from '@prisma/orm-family-sql/family/ir';
import {
  SqlNamespaceBase,
  type SqlNamespaceInput,
  type SqlNamespaceEntries,
  type SqlStorage,
  type StorageTable,
} from '@prisma/orm-family-sql/contract/types';

export const YDB_CONTROL_TABLES: ReadonlySet<string> = new Set([
  '_prisma_marker',
  '_prisma_ledger',
  '_prisma_ydb_migrations',
  '_prisma_ydb_lock',
]);

/** Quote an identifier, including a database-relative table path. */
export function quoteYdbIdentifier(value: string): string {
  if (value.includes('\0'))
    throw new Error('YDB identifiers cannot contain NUL.');
  return '`' + value.replaceAll('\\', '\\\\').replaceAll('`', '\\`') + '`';
}

/** A YDB connection is already bound to one database. */
export class YdbNamespace extends SqlNamespaceBase {
  declare readonly kind: string;
  readonly id: string;
  readonly entries: SqlNamespaceEntries;

  constructor(input: SqlNamespaceInput) {
    super();
    // Namespace implementation tags are runtime metadata. Hashing and snapshots
    // must agree on the persisted namespace shape (id + entries).
    Object.defineProperty(this, 'kind', {
      value: 'ydb-namespace',
      enumerable: false,
    });
    if (input.id !== UNBOUND_NAMESPACE_ID) {
      throw new Error(
        `YDB does not have SQL schemas: namespace ${input.id} is not supported. Use @@map for database-relative table paths.`,
      );
    }
    this.id = input.id;
    this.entries = Object.freeze(
      hydrateNamespaceEntities(
        input.entries,
        new Map([['table', tableEntityKind]]),
        'fail',
      ) as SqlNamespaceEntries,
    );
    Object.freeze(this);
  }

  get table(): Readonly<Record<string, StorageTable>> {
    return this.entries.table ?? {};
  }
  qualifier(): string {
    return '';
  }
  qualifyTable(tableName: string): string {
    return quoteYdbIdentifier(tableName);
  }
}

export const ydbCreateNamespace = (input: SqlNamespaceInput): YdbNamespace =>
  new YdbNamespace(input);

export class YdbContractSerializer extends SqlContractSerializerBase<
  Contract<SqlStorage>
> {
  override deserializeContract<T extends Contract = Contract<SqlStorage>>(
    json: unknown,
  ): T {
    // The framework descriptor erases family storage at this boundary; the base validates and hydrates SQL storage.
    return super.deserializeContract(json) as unknown as T;
  }

  protected override hydrateSqlNamespaceEntry(
    id: string,
    raw: Record<string, unknown>,
  ): YdbNamespace {
    return ydbCreateNamespace(
      super.hydrateSqlNamespaceEntry(id, raw) as SqlNamespaceInput,
    );
  }

  protected override constructTargetContract(
    contract: Contract<SqlStorage>,
  ): Contract<SqlStorage> {
    if (contract.target !== 'ydb')
      throw new Error(`Expected a YDB contract, received ${contract.target}.`);
    validateYdbContract(contract);
    return contract;
  }
}

/** Fail before applying DDL for features YDB cannot enforce. */
export function validateYdbContract(contract: Contract<SqlStorage>): void {
  for (const namespace of Object.values(contract.storage.namespaces)) {
    for (const [name, table] of Object.entries(namespace.entries.table ?? {})) {
      if (YDB_CONTROL_TABLES.has(name))
        throw new Error(
          `Table ${name} is reserved for YDB migration metadata.`,
        );
      if (!table.primaryKey || table.primaryKey.columns.length === 0)
        throw new Error(`YDB table ${name} requires a primary key.`);
      if (table.foreignKeys.length > 0)
        throw new Error(
          `YDB does not enforce foreign keys (${name}); set relationMode: 'application' in defineYdbConfig for PSL, or constraint: false in the TypeScript builder. The application must enforce referential integrity.`,
        );
      if ((table.checks?.length ?? 0) > 0)
        throw new Error(`YDB CHECK constraints are not supported (${name}).`);
      for (const [columnName, column] of Object.entries(table.columns)) {
        if (
          column.default?.kind === 'literal' &&
          (column.codecId === 'ydb/timestamp@1' ||
            column.codecId === 'ydb/string@1')
        ) {
          throw new Error(
            `Timestamp and byte-string storage defaults need a lossless contract literal round trip (${name}.${columnName}); supply the value explicitly.`,
          );
        }
        if (
          column.default?.kind === 'function' &&
          column.default.expression === 'autoincrement()' &&
          !table.primaryKey.columns.includes(columnName)
        ) {
          throw new Error(
            `YDB serial columns must participate in the primary key (${name}.${columnName}).`,
          );
        }
        if (column.many)
          throw new Error(
            `YDB table columns cannot store SQL arrays (${name}.${columnName}). Store structured data as Json.`,
          );
        if (
          column.default?.kind === 'function' &&
          column.default.expression !== 'autoincrement()'
        ) {
          throw new Error(
            `YDB only supports literal column defaults (${name}.${columnName}: ${column.default.expression}). Supply this value explicitly or declare a runtime mutation generator.`,
          );
        }
      }
      for (const index of table.indexes) {
        if (index.expression !== undefined || index.where !== undefined)
          throw new Error(
            `YDB expression/partial indexes are not supported (${name}).`,
          );
      }
    }
  }
}

export const ydbContractSerializer = new YdbContractSerializer();
