import type {
  Contract,
  ColumnDefault,
  ContractEnum,
} from '@prisma/orm-framework/contract/types';
import type { PslExtensionBlock } from '@prisma/orm-framework/components/authoring';
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
  type PslCompositeType,
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
import { ydbScalarDescriptors, yqlTypeForCodec } from '../runtime/codecs.js';
import { ydbDuration } from './contract.js';
import { ydbTableTtl } from './schema.js';

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
  Date: 'Date',
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
  if (nativeType === 'Timestamp') return 'timestamp`' + String(def.value) + '`';
  if (nativeType === 'Date') return 'date`' + String(def.value) + '`';
  if (nativeType === 'String')
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
  timestamps?: Record<string, NonNullable<PslField['typeConstructor']>>;
  valueObjects?: Record<string, string>;
  enums?: Record<string, { name: string; definition: ContractEnum }>;
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
      const enumField = shape.enums?.[columnName];
      const ref = column.codecRef;
      const codecName =
        ref &&
        Object.entries(ydbScalarDescriptors).find(
          ([, descriptor]) => descriptor.codecId === ref.codecId,
        )?.[0];
      const nativeType = ref
        ? yqlTypeForCodec(ref.codecId, ref.typeParams)
        : column.nativeType;
      const decimal = /^Decimal\((\d+),\s*(\d+)\)$/.exec(nativeType);
      const typeName =
        enumField?.name ??
        codecName ??
        (decimal ? 'Decimal' : typeNames[nativeType]);
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
      let defaultValue =
        shape.generators?.[columnName] ??
        defaultExpression(column.resolvedDefault, column.nativeType);
      if (ref?.many && column.resolvedDefault?.kind === 'literal') {
        const values = column.resolvedDefault.value;
        if (!Array.isArray(values))
          throw new Error('List defaults require arrays.');
        defaultValue = `[${values
          .map((value) => {
            if (!enumField)
              return defaultExpression({ kind: 'literal', value }, nativeType);
            const member = enumField.definition.members.find(
              (member) => member.value === value,
            );
            if (!member)
              throw new Error(
                `Cannot print enum list default for ${shape.name}.${fieldName(columnName)}.`,
              );
            return member.name;
          })
          .join(', ')}]`;
      }
      if (enumField && column.resolvedDefault && !ref?.many) {
        const def = column.resolvedDefault;
        const member =
          def.kind === 'literal'
            ? enumField.definition.members.find(
                (member) => member.value === def.value,
              )
            : undefined;
        if (!member)
          throw new Error(
            `Cannot print enum default for ${shape.name}.${fieldName(columnName)}.`,
          );
        defaultValue = member.name;
      }
      if (defaultValue !== undefined)
        attributes.push(attr('field', 'default', [positional(defaultValue)]));
      return {
        kind: 'field',
        name: fieldName(columnName),
        typeName: shape.valueObjects?.[columnName] ?? typeName,
        ...(decimal && nativeType !== 'Decimal(22,9)'
          ? {
              typeConstructor: {
                kind: 'typeConstructor' as const,
                path: ['Decimal'],
                args: [positional(decimal[1]!), positional(decimal[2]!)],
                span,
              },
            }
          : {}),
        ...(shape.timestamps?.[columnName]
          ? { typeConstructor: shape.timestamps[columnName] }
          : {}),
        optional: column.nullable,
        list: ref?.many === true,
        attributes,
        span,
      };
    },
  );
  const attributes: PslAttribute[] = [];
  const ttl = ydbTableTtl(shape.table);
  if (ttl)
    attributes.push(
      attr('model', 'ttl', [
        named('field', fieldName(ttl.column)),
        named(
          'expireAfter',
          JSON.stringify(ydbDuration(ttl.expireAfterSeconds)),
        ),
      ]),
    );
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
function document(
  models: PslModel[],
  enums: PslExtensionBlock[] = [],
  valueObjects: PslCompositeType[] = [],
): PslDocumentAst {
  const names = [...models, ...enums, ...valueObjects].map((item) => item.name);
  if (new Set(names).size !== names.length)
    throw new Error('YDB model/enum names collide after PSL naming.');
  return {
    kind: 'document',
    sourceId: '<ydb>',
    namespaces: [
      makePslNamespace({
        kind: 'namespace',
        name: UNSPECIFIED_PSL_NAMESPACE_ID,
        entries: makePslNamespaceEntries(models, valueObjects, enums),
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

/** Preserve model/column maps, string enums and runtime generators; refuse metadata this printer cannot preserve. */
export function printYdbPsl(
  contract: Contract<SqlStorage>,
  schema: SqlSchemaIR,
): PslDocumentAst {
  const models: PslModel[] = [];
  const enums: PslExtensionBlock[] = [];
  const valueObjects: PslCompositeType[] = [];
  const roots = new Map<string, string>();
  for (const [namespaceId, namespace] of Object.entries(
    contract.domain.namespaces,
  )) {
    if (namespaceId !== UNBOUND_NAMESPACE_ID)
      throw new Error('YDB contract print requires one namespace.');
    for (const [name, definition] of Object.entries(
      namespace.valueObjects ?? {},
    )) {
      const fields: PslField[] = Object.entries(definition.fields).map(
        ([fieldName, field]) => {
          if (field.dict || field.type.kind === 'union')
            throw new Error(
              `Cannot print value-object field ${name}.${fieldName}.`,
            );
          const typeName =
            field.type.kind === 'valueObject'
              ? field.type.name
              : (field.valueSet?.entityName ??
                Object.entries(ydbScalarDescriptors).find(
                  ([, descriptor]) =>
                    descriptor.codecId ===
                    (field.type as { codecId: string }).codecId,
                )?.[0]);
          if (!typeName)
            throw new Error(
              `Cannot print value-object field ${name}.${fieldName}.`,
            );
          const params =
            field.type.kind === 'scalar' ? field.type.typeParams : undefined;
          return {
            kind: 'field',
            name: fieldName,
            typeName,
            optional: field.nullable,
            list: !!field.many,
            attributes: [],
            span,
            ...(typeName === 'Decimal' && params
              ? {
                  typeConstructor: {
                    kind: 'typeConstructor' as const,
                    path: ['Decimal'],
                    args: [
                      positional(String(params['precision'])),
                      positional(String(params['scale'])),
                    ],
                    span,
                  },
                }
              : {}),
          };
        },
      );
      valueObjects.push({
        kind: 'compositeType',
        name,
        fields,
        attributes: [],
        span,
      });
    }
    for (const [name, definition] of Object.entries(namespace.enum ?? {})) {
      if (
        definition.codecId !== 'ydb/utf8@1' ||
        definition.members.some((member) => typeof member.value !== 'string')
      )
        throw new Error(
          `YDB contract print only supports string enums (${name}).`,
        );
      enums.push({
        kind: 'enum',
        keyword: 'enum',
        name,
        parameters: Object.fromEntries(
          definition.members.map((member) => [
            member.name,
            { expression: JSON.stringify(member.value), span },
          ]),
        ),
        blockAttributes: [
          {
            name: 'type',
            args: [
              {
                kind: 'positional',
                value: JSON.stringify(definition.codecId),
                span,
              },
            ],
            span,
          },
        ],
        span,
      });
    }
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
      roots.set(storage.table, modelName);
      const names = Object.fromEntries(
        Object.entries(storage.fields).map(([field, spec]) => [
          spec.column,
          field,
        ]),
      );
      const generators: Record<string, string> = {};
      const timestamps: NonNullable<ModelShape['timestamps']> = {};
      const valueObjectFields: Record<string, string> = {};
      const enumFields: NonNullable<ModelShape['enums']> = {};
      for (const [fieldName, field] of Object.entries(contractModel.fields)) {
        if (field.type.kind === 'valueObject') {
          const column = storage.fields[fieldName]?.column;
          if (!column)
            throw new Error(
              `Unmapped value-object field ${modelName}.${fieldName}.`,
            );
          valueObjectFields[column] = field.type.name;
        }
        const ref = field.valueSet;
        if (!ref) continue;
        const definition = namespace.enum?.[ref.entityName];
        const column = storage.fields[fieldName]?.column;
        if (
          ref.namespaceId !== namespaceId ||
          ref.spaceId !== undefined ||
          !definition ||
          !column ||
          field.type.kind !== 'scalar' ||
          field.type.codecId !== definition.codecId
        )
          throw new Error(`Cannot print enum field ${modelName}.${fieldName}.`);
        enumFields[column] = { name: ref.entityName, definition };
      }
      for (const entry of contract.execution?.mutations.defaults ?? []) {
        if (
          entry.ref.entry !== storage.table ||
          entry.ref.namespace !== storage.namespaceId
        )
          continue;
        const column = entry.ref.field;
        if (!Object.hasOwn(names, column))
          throw new Error('Generator references an unmapped field.');
        const phases: ('onCreate' | 'onUpdate')[] = [];
        for (const phase of ['onCreate', 'onUpdate'] as const) {
          const generated = entry[phase];
          if (
            generated?.kind === 'generator' &&
            generated.id === 'timestampNow'
          ) {
            if (generated.params && Object.keys(generated.params).length)
              throw new Error('timestampNow parameters are unsupported.');
            phases.push(phase);
          }
        }
        if (phases.length) {
          if (table.columns[column]?.nullable)
            throw new Error(
              'Prisma 8 rc.18 temporal presets cannot represent nullable fields.',
            );
          const codec = table.columns[column]?.codecRef?.codecId;
          const name =
            codec === 'ydb/timestamp@1'
              ? 'DateTime'
              : codec === 'ydb/timestamp-us@1'
                ? 'Timestamp'
                : codec === 'ydb/date@1'
                  ? 'Date'
                  : undefined;
          if (!name) throw new Error('timestampNow requires a temporal codec.');
          const preset =
            name === 'DateTime' && entry.onCreate?.id === 'timestampNow'
              ? entry.onUpdate
                ? 'updatedAt'
                : 'createdAt'
              : name;
          timestamps[column] = {
            kind: 'typeConstructor',
            path: ['temporal', preset],
            args:
              preset === 'createdAt' || preset === 'updatedAt'
                ? []
                : phases.map((phase) => named(phase, 'now')),
            span,
          };
        }
        if (entry.onUpdate && entry.onUpdate.id !== 'timestampNow')
          throw new Error(
            'YDB contract print cannot preserve onUpdate generators.',
          );
        const generated = entry.onCreate;
        if (!generated || generated.id === 'timestampNow') continue;
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
        generators[column] = expression;
      }
      models.push(
        model({
          name: modelName,
          table,
          names,
          generators,
          timestamps,
          valueObjects: valueObjectFields,
          enums: enumFields,
        }),
      );
    }
  }
  if (
    models.length !== Object.keys(schema.tables).length ||
    Object.keys(contract.roots).length !== roots.size ||
    Object.entries(contract.roots).some(
      ([name, ref]) =>
        roots.get(name) !== ref.model || ref.namespace !== UNBOUND_NAMESPACE_ID,
    )
  )
    throw new Error(
      'YDB contract print cannot preserve custom roots or unmapped tables.',
    );
  return document(models, enums, valueObjects);
}
