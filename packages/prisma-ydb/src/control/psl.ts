import type {
  Contract,
  ColumnDefault,
} from '@prisma/orm-framework/contract/types';
import { UNBOUND_NAMESPACE_ID } from '@prisma/orm-framework/components/ir';
import {
  makePslNamespace,
  makePslNamespaceEntries,
  UNSPECIFIED_PSL_NAMESPACE_ID,
  type PslDocumentAst,
  type PslModel,
  type PslField,
  type PslAttribute,
  type PslAttributeArgument,
  type PslSpan,
} from '@prisma/orm-framework/components/psl-ast';
import {
  SqlSchemaIR,
  type SqlTableIR,
} from '@prisma/orm-family-sql/schema-ir/types';
import type {
  SqlModelStorage,
  SqlStorage,
} from '@prisma/orm-family-sql/contract/types';
import {
  toFieldName,
  toModelName,
} from '@prisma/orm-family-sql/family/psl-infer';

const span: PslSpan = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 },
};
const positional = (value: string): PslAttributeArgument => ({
  kind: 'positional',
  value,
  span,
});
const named = (name: string, value: string): PslAttributeArgument => ({
  kind: 'named',
  name,
  value,
  span,
});
const attr = (
  target: 'model' | 'field',
  name: string,
  args: readonly PslAttributeArgument[] = [],
): PslAttribute => ({ kind: 'attribute', target, name, args, span });
const typeNames: Record<string, string> = {
  Utf8: 'String',
  Int32: 'Int',
  Int64: 'BigInt',
  Uint64: 'Uint64',
  Bool: 'Boolean',
  Double: 'Float',
  Timestamp: 'DateTime',
  Json: 'Json',
  String: 'Bytes',
  'Decimal(22,9)': 'Decimal',
};

function defaultExpression(
  def: ColumnDefault | undefined,
  nativeType: string,
): string | undefined {
  if (!def) return undefined;
  if (def.kind === 'function') {
    if (def.expression !== 'autoincrement()')
      throw new Error(`Cannot print YDB function default ${def.expression}.`);
    return def.expression;
  }
  if (nativeType === 'Int64' || nativeType === 'Uint64')
    return String(def.value);
  if (nativeType === 'Json')
    return 'json`' + JSON.stringify(def.value).replaceAll('`', '\\`') + '`';
  if (nativeType.startsWith('Decimal'))
    return 'decimal`' + String(def.value).replaceAll('`', '\\`') + '`';
  if (nativeType === 'Timestamp' || nativeType === 'String')
    throw new Error(
      `Printing ${nativeType} literal defaults requires a dedicated lossless literal syntax.`,
    );
  return JSON.stringify(def.value);
}

interface ModelShape {
  name: string;
  table: SqlTableIR;
  names?: Record<string, string>;
  generators?: Record<string, string>;
}
function model(shape: ModelShape): PslModel {
  const fieldNames =
    shape.names ??
    Object.fromEntries(
      Object.keys(shape.table.columns).map((name) => [
        name,
        toFieldName(name).name,
      ]),
    );
  if (
    new Set(Object.values(fieldNames)).size !== Object.keys(fieldNames).length
  )
    throw new Error(
      `YDB column names collide after PSL naming in ${shape.table.name}. Rename fields explicitly.`,
    );
  const fieldName = (column: string): string => {
    const name = fieldNames[column];
    if (!name) throw new Error(`Column ${column} has no model field.`);
    return name;
  };
  const fields: PslField[] = Object.entries(shape.table.columns).map(
    ([columnName, column]) => {
      const typeName = typeNames[column.nativeType];
      if (!typeName)
        throw new Error(
          `Cannot infer YDB type ${column.nativeType}; add a native codec before inference.`,
        );
      const attributes: PslAttribute[] = [];
      if (
        shape.table.primaryKey?.columns.length === 1 &&
        shape.table.primaryKey.columns[0] === columnName
      )
        attributes.push(attr('field', 'id'));
      if (fieldName(columnName) !== columnName)
        attributes.push(
          attr('field', 'map', [positional(JSON.stringify(columnName))]),
        );
      const defaultValue =
        shape.generators?.[columnName] ??
        defaultExpression(column.resolvedDefault, column.nativeType);
      if (defaultValue !== undefined)
        attributes.push(attr('field', 'default', [positional(defaultValue)]));
      return {
        kind: 'field',
        name: fieldName(columnName),
        typeName,
        optional: column.nullable,
        list: false,
        attributes,
        span,
      };
    },
  );
  const attributes: PslAttribute[] = [];
  if (shape.name !== shape.table.name)
    attributes.push(
      attr('model', 'map', [positional(JSON.stringify(shape.table.name))]),
    );
  const primaryKey = shape.table.primaryKey;
  if (primaryKey && primaryKey.columns.length > 1)
    attributes.push(
      attr('model', 'id', [
        positional(`[${primaryKey.columns.map(fieldName).join(', ')}]`),
      ]),
    );
  for (const index of shape.table.indexes) {
    if (!index.columns)
      throw new Error('YDB expression indexes cannot be inferred.');
    attributes.push(
      attr('model', 'index', [
        positional(`[${index.columns.map(fieldName).join(', ')}]`),
        named('map', JSON.stringify(index.name)),
      ]),
    );
  }
  for (const unique of shape.table.uniques)
    attributes.push(
      attr('model', 'unique', [
        positional(`[${unique.columns.map(fieldName).join(', ')}]`),
        ...(unique.name ? [named('map', JSON.stringify(unique.name))] : []),
      ]),
    );
  return { kind: 'model', name: shape.name, fields, attributes, span };
}
function document(models: PslModel[]): PslDocumentAst {
  if (new Set(models.map((item) => item.name)).size !== models.length)
    throw new Error('YDB table names collide after PSL naming.');
  return {
    kind: 'document',
    sourceId: '<ydb>',
    namespaces: [
      makePslNamespace({
        kind: 'namespace',
        name: UNSPECIFIED_PSL_NAMESPACE_ID,
        entries: makePslNamespaceEntries(models, [], []),
        span,
      }),
    ],
    span,
  };
}

export function inferYdbPsl(schema: unknown): PslDocumentAst {
  if (!(schema instanceof SqlSchemaIR))
    throw new Error('Expected the native YDB schema IR.');
  return document(
    Object.values(schema.tables).map((table) =>
      model({ name: toModelName(table.name).name, table }),
    ),
  );
}

/** Preserve model/column maps and runtime generators; refuse any metadata this printer cannot preserve. */
export function printYdbPsl(
  contract: Contract<SqlStorage>,
  schema: SqlSchemaIR,
): PslDocumentAst {
  const models: PslModel[] = [];
  for (const [namespaceId, namespace] of Object.entries(
    contract.domain.namespaces,
  )) {
    if (
      namespaceId !== UNBOUND_NAMESPACE_ID ||
      Object.keys(namespace.valueObjects ?? {}).length ||
      Object.keys(namespace.enum ?? {}).length
    )
      throw new Error(
        'YDB contract print currently requires one namespace and scalar models.',
      );
    for (const [modelName, contractModel] of Object.entries(namespace.models)) {
      if (
        Object.keys(contractModel.relations ?? {}).length ||
        Object.keys(contract.meta).length
      )
        throw new Error(
          'YDB contract print cannot yet preserve relations or custom metadata.',
        );
      const storage = contractModel.storage as SqlModelStorage;
      const table = schema.tables[storage.table];
      if (!table) throw new Error(`Model ${modelName} has no YDB table.`);
      const names = Object.fromEntries(
        Object.entries(storage.fields).map(([field, spec]) => [
          spec.column,
          field,
        ]),
      );
      const generators: Record<string, string> = {};
      for (const entry of contract.execution?.mutations.defaults ?? []) {
        if (
          entry.ref.entry !== modelName ||
          entry.ref.namespace !== namespaceId
        )
          continue;
        if (entry.onUpdate)
          throw new Error(
            'YDB contract print cannot preserve onUpdate generators.',
          );
        const generated = entry.onCreate;
        if (!generated || generated.kind !== 'generator')
          throw new Error('Unknown runtime generator.');
        const expression =
          generated.id === 'uuidv4'
            ? 'uuid()'
            : generated.id === 'uuidv7'
              ? 'uuid(7)'
              : generated.id === 'ulid'
                ? 'ulid()'
                : generated.id === 'cuid2'
                  ? 'cuid(2)'
                  : generated.id === 'nanoid'
                    ? `nanoid(${generated.params?.['size'] ?? ''})`
                    : undefined;
        if (!expression)
          throw new Error(`Cannot print runtime generator ${generated.id}.`);
        const column = storage.fields[entry.ref.field]?.column;
        if (!column) throw new Error('Generator references an unmapped field.');
        generators[column] = expression;
      }
      models.push(model({ name: modelName, table, names, generators }));
    }
  }
  if (
    models.length !== Object.keys(schema.tables).length ||
    Object.keys(contract.roots).some(
      (root) => !models.some((entry) => entry.name === root),
    )
  )
    throw new Error(
      'YDB contract print cannot preserve custom roots or unmapped tables.',
    );
  return document(models);
}
