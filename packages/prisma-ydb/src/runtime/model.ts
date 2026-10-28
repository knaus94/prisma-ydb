import { create } from '@bufbuild/protobuf';
import {
  TypeSchema,
  ValueSchema,
  type Value as WireValue,
} from '@ydbjs/api/value';
import { parameterType } from '../driver/values.js';
import { nativeCodecConversions, yqlTypeForCodec } from './codecs.js';
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
// Protobuf serialization only reads values, so optional null cells can share one.
const nullCell = create(ValueSchema, {
  value: { case: 'nullFlagValue', value: 0 },
});

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

export function modelMemberType(column: ModelColumn): string {
  const base = column.many
    ? 'Json'
    : yqlTypeForCodec(column.codecId, column.typeParams);
  return column.nullable ? `${base}?` : base;
}

/** Compile member types and cell encoders once for one model field set. */
export function compileModelRowEncoder(
  columns: readonly ModelColumn[],
  primaryKey?: readonly ModelColumn[],
) {
  const members = columns.map((column) => ({
    name: column.column,
    type: parameterType(modelMemberType(column)),
  }));
  const type = create(TypeSchema, {
    type: { case: 'structType', value: { members } },
  });
  const listType = create(TypeSchema, {
    type: { case: 'listType', value: { item: type } },
  });
  const encoders = columns.map((column) => {
    const codec = nativeCodecConversions(column.codecId, column.typeParams);
    const encode = column.many
      ? (value: unknown) => {
          if (!Array.isArray(value))
            throw new TypeError(
              `${column.field} is a list and requires an array`,
            );
          return create(ValueSchema, {
            value: {
              case: 'textValue',
              value: JSON.stringify(
                value.map((element: unknown) => {
                  if (element === null || element === undefined)
                    throw new TypeError(
                      `${column.field} list elements cannot be null`,
                    );
                  return codec.encodeJson(element);
                }),
              ),
            },
          });
        }
      : codec.encode;
    return {
      field: column.field,
      key: !!primaryKey?.includes(column),
      encode: (value: unknown): WireValue => {
        if (value === null || value === undefined) {
          if (!column.nullable)
            throw new TypeError(
              `${column.field} is required and cannot be null`,
            );
          return nullCell;
        }
        return encode(value);
      },
    };
  });
  return {
    type,
    listType,
    row(row: Readonly<Record<string, unknown>>, index: number): WireValue {
      const items: WireValue[] = new Array(encoders.length);
      for (let position = 0; position < encoders.length; position++) {
        const column = encoders[position];
        const value = Object.hasOwn(row, column.field)
          ? row[column.field]
          : undefined;
        if ((value === undefined || value === null) && column.key)
          throw new TypeError(
            `Row ${index} lacks primary key field ${column.field}`,
          );
        try {
          items[position] = column.encode(value);
        } catch (error) {
          throw new TypeError(
            `Row ${index}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return create(ValueSchema, { items });
    },
    list(items: WireValue[]) {
      return { type: listType, value: create(ValueSchema, { items }) };
    },
  };
}
