import type { Contract } from '@prisma/orm-framework/contract/types';
import type {
  SqlStorage,
  StorageTable,
} from '@prisma/orm-family-sql/contract/types';
import { optionsForTable, type YdbTableOptions } from '../control/options.js';

export interface ModelColumn {
  readonly field: string;
  readonly column: string;
  readonly codecId: string;
  readonly typeParams: unknown;
  readonly nullable: boolean;
  /** Scalar lists are stored as one Json column holding the elements' JSON forms. */
  readonly many: boolean;
}

/** One domain model resolved to its physical table, column codecs and YDB options. */
export interface ResolvedModel {
  readonly name: string;
  readonly namespace: string;
  readonly table: string;
  readonly definition: StorageTable;
  readonly options: YdbTableOptions;
  readonly columns: readonly ModelColumn[];
  readonly byField: ReadonlyMap<string, ModelColumn>;
  readonly byColumn: ReadonlyMap<string, ModelColumn>;
  readonly primaryKey: readonly ModelColumn[];
}

const cache = new WeakMap<Contract<SqlStorage>, Map<string, ResolvedModel>>();

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Resolve a model by name; the contract has exactly one domain namespace on YDB. */
export function resolveModel(
  contract: Contract<SqlStorage>,
  name: string,
): ResolvedModel {
  let models = cache.get(contract);
  if (!models) cache.set(contract, (models = new Map()));
  const cached = models.get(name);
  if (cached) return cached;
  const namespaces = Object.keys(contract.domain.namespaces);
  const namespace = namespaces[0];
  if (!namespace || namespaces.length !== 1)
    throw new Error('YDB expects one domain namespace');
  const model = record(
    record(contract.domain.namespaces[namespace])?.['models'],
  )?.[name];
  const storage = record(record(model)?.['storage']);
  const table = storage?.['table'];
  const fields = record(storage?.['fields']);
  if (!model || typeof table !== 'string' || !fields)
    throw new TypeError(`Unknown YDB model ${name}`);
  const storageNamespace =
    (typeof storage?.['namespaceId'] === 'string' &&
    contract.storage.namespaces[storage['namespaceId']]
      ? storage['namespaceId']
      : undefined) ?? Object.keys(contract.storage.namespaces)[0];
  const definition = storageNamespace
    ? contract.storage.namespaces[storageNamespace]?.entries.table?.[table]
    : undefined;
  if (!storageNamespace || !definition)
    throw new TypeError(`YDB model ${name} has no storage table ${table}`);
  const columns: ModelColumn[] = [];
  for (const [field, mapping] of Object.entries(fields)) {
    const column = record(mapping)?.['column'];
    if (typeof column !== 'string') continue;
    const stored = definition.columns[column];
    if (!stored) continue;
    columns.push({
      field,
      column,
      codecId: stored.codecId,
      typeParams: stored.typeParams,
      nullable: stored.nullable,
      many: !!stored.many,
    });
  }
  const byField = new Map(columns.map((entry) => [entry.field, entry]));
  const byColumn = new Map(columns.map((entry) => [entry.column, entry]));
  const primaryKey = (definition.primaryKey?.columns ?? []).map((column) => {
    const entry = byColumn.get(column);
    if (!entry)
      throw new TypeError(`YDB model ${name} key column ${column} is unmapped`);
    return entry;
  });
  const resolved: ResolvedModel = {
    name,
    namespace: storageNamespace,
    table,
    definition,
    options: optionsForTable(
      contract.storage.namespaces[storageNamespace] as {
        entries: Record<string, unknown>;
      },
      table,
    ),
    columns,
    byField,
    byColumn,
    primaryKey,
  };
  models.set(name, resolved);
  return resolved;
}
