import type { Contract } from '@prisma/orm-framework/contract/types';
import type {
  ExtractFieldInputTypes,
  ExtractFieldOutputTypes,
  SqlStorage,
} from '@prisma/orm-family-sql/contract/types';
import type { YdbParameter, YdbQueryResult } from '../driver/types.js';
import { nativeCodecConversions } from './codecs.js';
import { quoteYqlIdentifier } from './compiler.js';
import {
  compileModelRowEncoder,
  modelMemberType,
  resolveModel,
  type ModelColumn,
} from './model.js';

export type YdbModelName<C extends Contract<SqlStorage>> =
  keyof C['domain']['namespaces'][keyof C['domain']['namespaces']]['models'] &
    string;

type ModelFields<Map, Name extends string> = {
  [Ns in keyof Map]: Name extends keyof Map[Ns] ? Map[Ns][Name] : never;
}[keyof Map];
type ModelRow<Map, Name extends string> = [ModelFields<Map, Name>] extends [
  never,
]
  ? Record<string, unknown>
  : ModelFields<Map, Name>;
export type YdbYqlInput<
  C extends Contract<SqlStorage>,
  Name extends YdbModelName<C>,
> = ModelRow<ExtractFieldInputTypes<C>, Name>;
export type YdbYqlOutput<
  C extends Contract<SqlStorage>,
  Name extends YdbModelName<C>,
> = ModelRow<ExtractFieldOutputTypes<C>, Name>;

type NullableFields<Row> = {
  [Field in keyof Row]: null extends Row[Field] ? Field : never;
}[keyof Row];
type RowInput<Row> = Omit<Row, NullableFields<Row>> &
  Partial<Pick<Row, NullableFields<Row>>>;

export interface YdbYqlColumn {
  readonly field: string;
  readonly column: string;
  readonly yqlType: string;
  readonly nullable: boolean;
  readonly many: boolean;
}

export interface YdbYqlModel<Input, Output = Input> {
  /** Quoted physical table path, ready to interpolate into YQL. */
  readonly table: string;
  readonly columns: readonly YdbYqlColumn[];
  readonly structType: string;
  readonly listType: string;
  declare(paramName: string, kind: 'list' | 'struct'): string;
  rows(rows: readonly RowInput<Input>[]): YdbParameter;
  row(row: RowInput<Input>): YdbParameter;
  decode(row: Readonly<Record<string, unknown>>): Output;
  /** Decode flat native rows or all result sets of a buffered query result. */
  decodeAll(
    result: readonly Readonly<Record<string, unknown>>[] | YdbQueryResult,
  ): Output[];
}

function columnDecoder(column: ModelColumn): (value: unknown) => unknown {
  const codec = nativeCodecConversions(column.codecId, column.typeParams);
  const decode = column.many
    ? (value: unknown) => {
        if (!Array.isArray(value))
          throw new TypeError(
            `${column.field} is a list and requires an array`,
          );
        return value.map((element: unknown) => {
          if (element === null || element === undefined)
            throw new TypeError(`${column.field} list elements cannot be null`);
          // The ORM list path decodes each element from the codec JSON form.
          return codec.decodeJson(
            element as Parameters<typeof codec.decodeJson>[0],
          );
        });
      }
    : codec.decode;
  return (value) => {
    if (value === null) {
      if (!column.nullable)
        throw new TypeError(`${column.field} is required and cannot be null`);
      return null;
    }
    return decode(value);
  };
}

/** Contract-derived declarations, wire parameters and model-shaped native results. */
export function yqlModel<
  C extends Contract<SqlStorage>,
  Name extends YdbModelName<C>,
  const Field extends keyof YdbYqlInput<C, Name> &
    keyof YdbYqlOutput<C, Name> &
    string = keyof YdbYqlInput<C, Name> & keyof YdbYqlOutput<C, Name> & string,
>(
  contract: C,
  name: Name,
  options: { readonly fields?: readonly Field[] } = {},
): YdbYqlModel<
  Pick<YdbYqlInput<C, Name>, Field>,
  Pick<YdbYqlOutput<C, Name>, Field>
> {
  const model = resolveModel(contract, name);
  const selected = options.fields
    ? options.fields.map((field) => {
        const column = model.byField.get(field);
        if (!column)
          throw new TypeError(`Unknown field ${field} on YDB model ${name}`);
        return column;
      })
    : model.columns;
  if (!selected.length)
    throw new TypeError('A YQL model requires at least one field');
  for (const column of selected)
    if (
      column.field === '__proto__' ||
      column.field === 'constructor' ||
      column.field === 'prototype'
    )
      throw new TypeError(`Unsafe YQL model field ${column.field}`);
  const fields = new Set(selected.map((column) => column.field));
  if (fields.size !== selected.length)
    throw new TypeError('YQL model fields must be unique');
  const columns = selected.map((column) => ({
    field: column.field,
    column: column.column,
    yqlType: modelMemberType(column),
    nullable: column.nullable,
    many: column.many,
  }));
  const encoder = compileModelRowEncoder(selected);
  const decoders = selected.map(columnDecoder);
  const structType = `Struct<${columns.map((column) => `${quoteYqlIdentifier(column.column)}:${column.yqlType}`).join(',')}>`;
  const listType = `List<${structType}>`;
  const encode = (row: unknown, index: number) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row))
      throw new TypeError(`Row ${index} must be an object`);
    for (const field in row)
      if (Object.hasOwn(row, field) && !fields.has(field))
        throw new TypeError(`Unknown field ${field} on YQL model ${name}`);
    return encoder.row(row as Readonly<Record<string, unknown>>, index);
  };
  type Output = Pick<YdbYqlOutput<C, Name>, Field>;
  const decode = (row: Readonly<Record<string, unknown>>): Output => {
    const result: Record<string, unknown> = {};
    for (let index = 0; index < selected.length; index++) {
      const column = selected[index];
      if (!Object.hasOwn(row, column.column))
        throw new TypeError(`Missing YDB column ${column.column}`);
      result[column.field] = decoders[index](row[column.column]);
    }
    return result as Output;
  };
  return {
    table: quoteYqlIdentifier(model.table),
    columns,
    structType,
    listType,
    declare(paramName, kind) {
      const parameter = paramName.startsWith('$') ? paramName : `$${paramName}`;
      if (!/^\$[A-Za-z_][A-Za-z0-9_]*$/.test(parameter))
        throw new TypeError('Invalid YDB parameter name');
      if (kind !== 'list' && kind !== 'struct')
        throw new TypeError('YQL model declaration requires list or struct');
      return `DECLARE ${parameter} AS ${kind === 'list' ? listType : structType};`;
    },
    rows: (rows) => encoder.list(rows.map(encode)),
    row: (row) => ({ type: encoder.type, value: encode(row, 0) }),
    decode,
    decodeAll(result) {
      const rows =
        'resultSets' in result
          ? result.resultSets.flatMap((set) => set.rows)
          : result;
      return rows.map(decode);
    },
  };
}
