import { quoteYdbIdentifier } from './literals.js';
export {
  quoteYdbIdentifier,
  ydbDuration,
  ydbDurationSeconds,
} from './literals.js';
import {
  CrossReferenceSchema,
  type Contract,
} from '@prisma/orm-framework/contract/types';
import {
  UNBOUND_NAMESPACE_ID,
  hydrateNamespaceEntities,
} from '@prisma/orm-framework/components/ir';
import { composeSqlEntityKinds } from '@prisma/orm-family-sql/contract/entity-kinds';
import { SqlContractSerializerBase } from '@prisma/orm-family-sql/family/ir';
import {
  SqlNamespaceBase,
  type SqlNamespaceInput,
  type SqlNamespaceEntries,
  type SqlStorage,
  type StorageTable,
} from '@prisma/orm-family-sql/contract/types';

import {
  normalizeYdbOptions,
  optionsForTable,
  ydbOptionsKind,
} from './options.js';

export const YDB_CONTROL_TABLES: ReadonlySet<string> = new Set([
  '_prisma_marker',
  '_prisma_ledger',
  '_prisma_ydb_migrations',
  '_prisma_ydb_lock',
]);

export interface YdbTtl {
  readonly table: string;
  readonly column: string;
  readonly expireAfterSeconds: number;
}

export const YDB_TEMPORAL_CODECS: ReadonlySet<string> = new Set([
  'ydb/timestamp@1',
  'ydb/timestamp-us@1',
  'ydb/date@1',
]);

const ttlKind = {
  kind: 'ttl',
  schema: CrossReferenceSchema.or('unknown').narrow((value, ctx) => {
    if (typeof value !== 'object' || value === null)
      return ctx.mustBe('a YDB TTL policy');
    const ttl = value as Record<string, unknown>;
    return (
      (typeof ttl['table'] === 'string' &&
        typeof ttl['column'] === 'string' &&
        typeof ttl['expireAfterSeconds'] === 'number' &&
        Number.isSafeInteger(ttl['expireAfterSeconds']) &&
        ttl['expireAfterSeconds'] >= 0 &&
        ttl['expireAfterSeconds'] <= 9223372036854 &&
        Object.keys(ttl).every((key) =>
          ['table', 'column', 'expireAfterSeconds'].includes(key),
        )) ||
      ctx.mustBe('a canonical YDB TTL policy')
    );
  }),
  construct: (input: YdbTtl): YdbTtl => Object.freeze({ ...input }),
};

const ydbEntityKinds = composeSqlEntityKinds([ttlKind, ydbOptionsKind]);

export function ydbTtlEntries(namespace: {
  readonly entries: SqlNamespaceEntries;
}): Readonly<Record<string, YdbTtl>> {
  return (namespace.entries['ttl'] ?? {}) as Readonly<Record<string, YdbTtl>>;
}

/** A YDB connection is already bound to one database. */
export class YdbNamespace extends SqlNamespaceBase {
  declare readonly kind: string;
  readonly id: string;
  readonly entries: SqlNamespaceEntries;

  constructor(input: SqlNamespaceInput) {
    super();
    input = normalizeYdbOptions(input);
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
        ydbEntityKinds,
        'fail',
        input.id,
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
  constructor() {
    super(undefined, [ttlKind, ydbOptionsKind]);
  }
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
  for (const [namespaceId, namespace] of Object.entries(
    contract.storage.namespaces,
  )) {
    for (const [name, table] of Object.entries(namespace.entries.table ?? {})) {
      if (YDB_CONTROL_TABLES.has(name))
        throw new Error(
          `Table ${name} is reserved for YDB migration metadata.`,
        );
      if (!table.primaryKey || table.primaryKey.columns.length === 0)
        throw new Error(`YDB table ${name} requires a primary key.`);
      const managed = optionsForTable(namespace, name);
      if (managed.store?.kind === 'column') {
        const unsupported = [
          managed.partitioning && 'row-table @@partitioning',
          managed.changefeeds?.length && '@@changefeed',
          ydbTtlEntries(namespace)[name] && '@@ttl',
          table.indexes.length && '@@index',
          table.uniques.length && '@@unique',
          Object.values(table.columns).some(
            (column) => column.codecId === 'ydb/uuid@1',
          ) && 'Uuid columns',
          table.foreignKeys.some(
            (key) => key.onDelete !== undefined || key.onUpdate !== undefined,
          ) && 'relation actions',
        ].filter((item): item is string => typeof item === 'string');
        if (unsupported.length)
          throw new Error(
            `YDB column-store table ${name} does not support ${unsupported.join(', ')}.`,
          );
      }
      for (const key of table.foreignKeys) {
        if (key.onDelete === undefined && key.onUpdate === undefined) continue;
        const target =
          contract.storage.namespaces[key.target.namespaceId || namespaceId]
            ?.entries.table?.[key.target.tableName];
        const targetOptions = optionsForTable(
          contract.storage.namespaces[key.target.namespaceId || namespaceId] ??
            namespace,
          key.target.tableName,
        );
        if (target && targetOptions.store?.kind === 'column')
          throw new Error(
            `YDB relation actions cannot reference column-store table ${key.target.tableName} (${name}); row and column tables never share a write transaction.`,
          );
      }
      if (
        managed.partitioning?.uniformPartitions !== undefined ||
        managed.changefeeds?.some((feed) => feed.partitions !== undefined)
      ) {
        const first = table.primaryKey.columns[0];
        if (
          !first ||
          !['ydb/uint64@1', 'ydb/uint32@1'].includes(
            table.columns[first]?.codecId ?? '',
          )
        )
          throw new Error(
            'Uniform table/topic partitions require a Uint32/Uint64-leading primary key (' +
              name +
              ').',
          );
      }
      for (const key of table.foreignKeys) {
        if (key.onDelete === undefined && key.onUpdate === undefined)
          throw new Error(
            `YDB does not enforce foreign keys (${name}); set relationMode: 'application' in defineYdbConfig for PSL, or constraint: false in the TypeScript builder. Retained client-side foreign keys must declare onDelete or onUpdate.`,
          );
        if (
          key.onDelete === 'setDefault' ||
          (key.onUpdate !== undefined &&
            key.onUpdate !== 'noAction' &&
            key.onUpdate !== 'restrict')
        )
          throw new Error(
            `YDB referential actions reject SetDefault and onUpdate other than NoAction/Restrict (${name}).`,
          );
        if (
          key.onDelete === 'setNull' &&
          key.source.columns.some((column) => !table.columns[column]?.nullable)
        )
          throw new Error(
            `YDB SetNull requires nullable child foreign-key columns (${name}).`,
          );
      }
      if ((table.checks?.length ?? 0) > 0)
        throw new Error(`YDB CHECK constraints are not supported (${name}).`);
      for (const [columnName, column] of Object.entries(table.columns)) {
        if (
          column.default?.kind === 'literal' &&
          !column.many &&
          column.codecId === 'ydb/string@1'
        ) {
          throw new Error(
            `Byte-string storage defaults need a lossless contract literal round trip (${name}.${columnName}); supply the value explicitly.`,
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
        if (column.many && column.codecId === 'ydb/json@1')
          throw new Error(
            `YDB Json[] columns are unsupported (${name}.${columnName}); use Json for structured arrays.`,
          );
        if (column.many && column.many.elementNullable)
          throw new Error(
            `YDB list elements cannot be nullable (${name}.${columnName}).`,
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
    const policies = new Set<string>();
    for (const ttl of Object.values(ydbTtlEntries(namespace))) {
      const column = namespace.entries.table?.[ttl.table]?.columns[ttl.column];
      if (!column || column.many || !YDB_TEMPORAL_CODECS.has(column.codecId))
        throw new Error(
          `YDB TTL requires a scalar temporal column (${ttl.table}.${ttl.column}).`,
        );
      if (policies.has(ttl.table))
        throw new Error(
          `Only one YDB TTL policy is allowed per table (${ttl.table}).`,
        );
      policies.add(ttl.table);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (namespaceId: string, name: string): void => {
    const id = JSON.stringify([namespaceId, name]);
    if (visiting.has(id))
      throw new Error(
        'YDB Cascade cycles, including self-relations, are unsupported: recursive deletes require an acyclic static YQL program.',
      );
    if (visited.has(id)) return;
    visiting.add(id);
    const table =
      contract.storage.namespaces[namespaceId]?.entries.table?.[name];
    for (const key of table?.foreignKeys ?? [])
      if (key.onDelete === 'cascade')
        visit(key.target.namespaceId, key.target.tableName);
    visiting.delete(id);
    visited.add(id);
  };
  for (const [namespaceId, namespace] of Object.entries(
    contract.storage.namespaces,
  ))
    for (const name of Object.keys(namespace.entries.table ?? {}))
      visit(namespaceId, name);
}

export const ydbContractSerializer = new YdbContractSerializer();
