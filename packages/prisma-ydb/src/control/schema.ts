import { anyUnpack } from '@bufbuild/protobuf/wkt';
import {
  SchemeServiceDefinition,
  ListDirectoryResultSchema,
  Entry_Type,
} from '@ydbjs/api/scheme';
import {
  TableServiceDefinition,
  CreateSessionResultSchema,
  DescribeTableResultSchema,
  StoreType,
  TableIndexDescription_Status,
  type DescribeTableResult,
} from '@ydbjs/api/table';
import { StatusIds_StatusCode, type Operation } from '@ydbjs/api/operation';
import { Type_PrimitiveTypeId, type Type } from '@ydbjs/api/value';
import { ydbTableExists } from '../driver/scheme.js';
import { decodeValue } from '../driver/values.js';
import { decimalText } from '../runtime/decimal.js';
import type { Driver } from '@ydbjs/core';
import type {
  Contract,
  ColumnDefault,
} from '@prisma/orm-framework/contract/types';
import { diffSchemas } from '@prisma/orm-framework/components/control';
import type { TargetBoundComponentDescriptor } from '@prisma/orm-framework/components/components';
import {
  contractToSchemaIR,
  sqlTypeLookupsOf,
  type SqlSchemaDiffResult,
} from '@prisma/orm-family-sql/family/control';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import {
  SqlSchemaIR,
  SqlTableIR,
  type SqlColumnIRInput,
  type SqlSchemaIRNode,
} from '@prisma/orm-family-sql/schema-ir/types';
import {
  quoteYdbIdentifier,
  validateYdbContract,
  YDB_CONTROL_TABLES,
} from './contract.js';

export const CONTROL_TABLES = YDB_CONTROL_TABLES;

function checked(
  operation: Operation | undefined,
): NonNullable<Operation['result']> {
  if (
    !operation ||
    !operation.ready ||
    operation.status !== StatusIds_StatusCode.SUCCESS ||
    !operation.result
  ) {
    throw new Error(
      `YDB schema operation failed: ${JSON.stringify(operation?.issues ?? [])} (status ${operation?.status ?? 'missing'})`,
    );
  }
  return operation.result;
}

export async function listYdbTables(core: Driver): Promise<string[]> {
  const client = core.createClient(SchemeServiceDefinition);
  const tables: string[] = [];
  async function walk(relative: string): Promise<void> {
    const response = await client.listDirectory(
      { path: `${core.database}${relative ? '/' + relative : ''}` },
      { signal: AbortSignal.timeout(30_000) },
    );
    const result = anyUnpack(
      checked(response.operation),
      ListDirectoryResultSchema,
    );
    if (!result)
      throw new Error('YDB returned an invalid ListDirectory result.');
    for (const child of result.children) {
      const path = relative ? `${relative}/${child.name}` : child.name;
      if (
        child.type === Entry_Type.COLUMN_TABLE ||
        child.type === Entry_Type.COLUMN_STORE
      )
        throw new Error(
          `YDB column-oriented object ${path} cannot be represented by this row-table contract.`,
        );
      if (child.type === Entry_Type.DIRECTORY && !child.name.startsWith('.'))
        await walk(path);
      if (child.type === Entry_Type.TABLE && !CONTROL_TABLES.has(path))
        tables.push(path);
    }
  }
  await walk('');
  return tables.sort();
}

async function withTableSession<T>(
  core: Driver,
  fn: (describe: (name: string) => Promise<DescribeTableResult>) => Promise<T>,
): Promise<T> {
  const client = core.createClient(TableServiceDefinition);
  const created = await client.createSession(
    {},
    { signal: AbortSignal.timeout(30_000) },
  );
  const session = anyUnpack(
    checked(created.operation),
    CreateSessionResultSchema,
  );
  if (!session) throw new Error('YDB returned an invalid table session.');
  const closeSession = async (): Promise<void> => {
    const deleted = await client.deleteSession(
      { sessionId: session.sessionId },
      { signal: AbortSignal.timeout(5_000) },
    );
    if (
      !deleted.operation?.ready ||
      deleted.operation.status !== StatusIds_StatusCode.SUCCESS
    )
      throw new Error(
        `YDB table session cleanup failed (status ${deleted.operation?.status ?? 'missing'}).`,
      );
  };
  let result!: T;
  let failed = false;
  let failure: unknown;
  try {
    result = await fn(async (name) => {
      const response = await client.describeTable(
        { sessionId: session.sessionId, path: `${core.database}/${name}` },
        { signal: AbortSignal.timeout(30_000) },
      );
      const decoded = anyUnpack(
        checked(response.operation),
        DescribeTableResultSchema,
      );
      if (!decoded)
        throw new Error('YDB returned an invalid DescribeTable result.');
      return decoded;
    });
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await closeSession();
    } catch (cleanupError) {
      failure = failed
        ? new AggregateError(
            [failure, cleanupError],
            'YDB table description and session cleanup both failed.',
          )
        : cleanupError;
      failed = true;
    }
  }
  if (failed) throw failure;
  return result;
}

export async function describeYdbTable(
  core: Driver,
  name: string,
): Promise<DescribeTableResult> {
  return withTableSession(core, (describe) => describe(name));
}

function nativeType(type: Type | undefined): string {
  if (type?.type.case === 'optionalType')
    return nativeType(type.type.value.item);
  if (type?.type.case === 'decimalType')
    return `Decimal(${type.type.value.precision},${type.type.value.scale})`;
  if (type?.type.case !== 'typeId')
    throw new Error(`Unsupported YDB table type: ${JSON.stringify(type)}`);
  const names: Partial<Record<Type_PrimitiveTypeId, string>> = {
    [Type_PrimitiveTypeId.BOOL]: 'Bool',
    [Type_PrimitiveTypeId.INT8]: 'Int8',
    [Type_PrimitiveTypeId.INT16]: 'Int16',
    [Type_PrimitiveTypeId.INT32]: 'Int32',
    [Type_PrimitiveTypeId.INT64]: 'Int64',
    [Type_PrimitiveTypeId.UINT8]: 'Uint8',
    [Type_PrimitiveTypeId.UINT16]: 'Uint16',
    [Type_PrimitiveTypeId.UINT32]: 'Uint32',
    [Type_PrimitiveTypeId.UINT64]: 'Uint64',
    [Type_PrimitiveTypeId.FLOAT]: 'Float',
    [Type_PrimitiveTypeId.DOUBLE]: 'Double',
    [Type_PrimitiveTypeId.STRING]: 'String',
    [Type_PrimitiveTypeId.UTF8]: 'Utf8',
    [Type_PrimitiveTypeId.JSON]: 'Json',
    [Type_PrimitiveTypeId.JSON_DOCUMENT]: 'JsonDocument',
    [Type_PrimitiveTypeId.TIMESTAMP]: 'Timestamp',
    [Type_PrimitiveTypeId.DATE]: 'Date',
    [Type_PrimitiveTypeId.DATETIME]: 'Datetime',
    [Type_PrimitiveTypeId.INTERVAL]: 'Interval',
    [Type_PrimitiveTypeId.UUID]: 'Uuid',
    [Type_PrimitiveTypeId.YSON]: 'Yson',
  };
  const name = names[type.type.value];
  if (!name)
    throw new Error(`Unrecognized YDB primitive type: ${type.type.value}.`);
  return name;
}

export function renderYdbLiteral(value: unknown, type: string): string {
  // Contract JSON literals contain decoded JSON, including strings and JSON null.
  // SQL NULL is a different wire value and is rejected when introspecting JSON defaults.
  if (type === 'Json' || type === 'JsonDocument') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new Error('JSON defaults require a JSON value.');
    return `${type}(${JSON.stringify(encoded)})`;
  }
  if (value === null) return 'NULL';
  const decimal = /^Decimal\((\d+),\s*(\d+)\)$/.exec(type);
  if (decimal) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2]);
    return `Decimal(${JSON.stringify(decimalText(value, precision, scale))}, ${precision}, ${scale})`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('YDB literal defaults must be finite.');
    return `${type}(${JSON.stringify(String(value))})`;
  }
  if (typeof value === 'bigint')
    return `${type}(${JSON.stringify(value.toString())})`;
  if (typeof value === 'string') return `${type}(${JSON.stringify(value)})`;
  throw new Error(`Cannot represent a ${type} literal default.`);
}

function rawDefault(def: ColumnDefault, type: string): string {
  if (def.kind === 'function') {
    if (def.expression === 'autoincrement()') return 'autoincrement()';
    throw new Error(
      `YDB does not support function defaults: ${def.expression}.`,
    );
  }
  return renderYdbLiteral(def.value, type);
}

function tableToSchema(name: string, table: DescribeTableResult): SqlTableIR {
  if (table.temporary || table.storeType === StoreType.COLUMN)
    throw new Error(
      `YDB temporary or column-oriented table ${name} is not supported by the row-table migration model.`,
    );
  if (table.ttlSettings?.mode.case || table.tiering)
    throw new Error(
      `YDB table ${name} has TTL/tiering semantics which this contract cannot preserve. Native expiry policy must be modeled before schema signing or migration.`,
    );
  for (const index of table.indexes) {
    if (index.status !== TableIndexDescription_Status.READY)
      throw new Error(
        `YDB index ${name}.${index.name} is not ready; wait for index construction before signing the schema.`,
      );
    if (index.dataColumns.length)
      throw new Error(
        `YDB covering index ${name}.${index.name} cannot be represented as an ordinary Prisma index.`,
      );
  }
  const columns: Record<string, SqlColumnIRInput> = {};
  for (const column of table.columns) {
    const type = nativeType(column.type);
    let def: ColumnDefault | undefined;
    if (column.defaultValue.case === 'fromSequence')
      def = { kind: 'function', expression: 'autoincrement()' };
    if (column.defaultValue.case === 'fromLiteral') {
      const literal = column.defaultValue.value;
      if (!literal.type || !literal.value)
        throw new Error(`Invalid default for ${name}.${column.name}`);
      if (
        (type === 'Json' || type === 'JsonDocument') &&
        literal.value.value.case === 'nullFlagValue'
      )
        throw new Error(
          `SQL NULL and JSON null defaults need distinct contract literals (${name}.${column.name}); SQL NULL JSON-column defaults cannot yet be inferred.`,
        );
      const js = decodeValue(literal.value, literal.type);
      if (type === 'Timestamp' || type === 'String')
        throw new Error(
          `Introspection of ${type} literal defaults needs a lossless contract literal syntax (${name}.${column.name}).`,
        );
      def = {
        kind: 'literal',
        value: typeof js === 'bigint' ? js.toString() : js,
      } as ColumnDefault;
    }
    columns[column.name] = {
      name: column.name,
      nativeType: type,
      resolvedNativeType: type,
      nullable:
        column.notNull !== undefined
          ? !column.notNull
          : column.type?.type.case === 'optionalType',
      ...(def ? { default: rawDefault(def, type), resolvedDefault: def } : {}),
    };
  }
  return new SqlTableIR({
    name,
    columns,
    primaryKey: { columns: table.primaryKey },
    foreignKeys: [],
    uniques: table.indexes
      .filter((index) => index.type.case === 'globalUniqueIndex')
      .map((index) => ({ columns: index.indexColumns, name: index.name })),
    indexes: table.indexes
      .filter((index) => index.type.case !== 'globalUniqueIndex')
      .map((index) => {
        if (index.type.case !== 'globalIndex')
          throw new Error(
            `Index ${name}.${index.name} is not a synchronous secondary index; its semantics cannot be inferred as an ordinary Prisma index.`,
          );
        return {
          naming: { kind: 'exact' as const, name: index.name },
          columns: index.indexColumns,
          unique: false,
          type: undefined,
          options: undefined,
          where: undefined,
          annotations: undefined,
          dependsOn: undefined,
          partial: false,
        };
      }),
  });
}

export async function introspectYdbTable(
  core: Driver,
  name: string,
): Promise<SqlTableIR | undefined> {
  if (CONTROL_TABLES.has(name) || !(await ydbTableExists(core, name)))
    return undefined;
  return withTableSession(core, async (describe) =>
    tableToSchema(name, await describe(name)),
  );
}

export async function introspectYdb(core: Driver): Promise<SqlSchemaIR> {
  const names = await listYdbTables(core);
  if (!names.length) return new SqlSchemaIR({ tables: {} });
  return withTableSession(core, async (describe) => {
    const tables: Record<string, SqlTableIR> = {};
    let next = 0;
    const results = await Promise.allSettled(
      Array.from({ length: Math.min(8, names.length) }, async () => {
        while (next < names.length) {
          const name = names[next++];
          const table = await describe(name);
          tables[name] = tableToSchema(name, table);
        }
      }),
    );
    for (const result of results)
      if (result.status === 'rejected') throw result.reason;
    return new SqlSchemaIR({
      tables: Object.fromEntries(names.map((name) => [name, tables[name]])),
    });
  });
}

export function ydbContractToSchema(
  contract: Contract<SqlStorage> | null,
  components: readonly TargetBoundComponentDescriptor<'sql', string>[],
): SqlSchemaIR {
  if (contract) validateYdbContract(contract);
  const types = sqlTypeLookupsOf(components);
  return contractToSchemaIR(contract, {
    annotationNamespace: 'ydb',
    ...types,
    renderDefault: (def, _column, type) => rawDefault(def, type.baseTypeName),
  });
}

export function diffYdbSchema(input: {
  contract: Contract<SqlStorage>;
  schema: SqlSchemaIRNode;
  frameworkComponents: readonly TargetBoundComponentDescriptor<'sql', string>[];
}): SqlSchemaDiffResult {
  if (!(input.schema instanceof SqlSchemaIR))
    throw new Error('Expected a YDB SQL schema IR.');
  const expected = ydbContractToSchema(
    input.contract,
    input.frameworkComponents,
  );
  const actual = input.schema;
  return {
    issues: diffSchemas(expected, actual),
    namespacePairs: [{ actual }],
    resolveControlPolicy: (issue) => {
      const name = issue.path[1];
      if (!name) return undefined;
      return Object.values(input.contract.storage.namespaces).find(
        (namespace) => namespace.entries.table?.[name],
      )?.entries.table?.[name]?.control;
    },
  };
}

export function renderYdbColumn(column: SqlColumnIRInput): string {
  const def = column.authoredDefault ?? column.resolvedDefault;
  const type =
    def?.kind === 'function' && def.expression === 'autoincrement()'
      ? column.nativeType === 'Int32'
        ? 'Serial'
        : column.nativeType === 'Int64'
          ? 'BigSerial'
          : (() => {
              throw new Error('YDB autoincrement requires Int32 or Int64.');
            })()
      : column.nativeType;
  return `${quoteYdbIdentifier(column.name)} ${type}${column.nullable ? '' : ' NOT NULL'}${def && def.kind !== 'function' ? ' DEFAULT ' + rawDefault(def, column.nativeType) : ''}`;
}
