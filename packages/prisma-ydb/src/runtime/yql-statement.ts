import { assertUsedYqlParams, yqlCode } from '../driver/yql-syntax.js';
import type {
  YdbParameter,
  YdbQueryRequest,
  YdbQueryResult,
} from '../driver/types.js';
import {
  struct,
  type YdbTypeDescriptor,
  type YdbTypeInput,
  type YdbTypeOutput,
} from './codecs.js';
import { quoteYqlIdentifier } from './compiler.js';
import type { YdbYqlColumn } from './yql-model.js';

export type YdbYqlParams = Readonly<Record<string, YdbTypeDescriptor>>;
export type YdbYqlValues<Params extends YdbYqlParams> = {
  [Key in keyof Params]: YdbTypeInput<Params[Key]>;
};
export type YdbYqlResultSpec =
  | YdbTypeDescriptor
  | {
      decode(row: Readonly<Record<string, unknown>>): unknown;
    }
  | Readonly<Record<string, YdbTypeDescriptor>>;
export type YdbYqlResults = Readonly<Record<string, YdbYqlResultSpec>>;
type ResultRow<Spec> = Spec extends { decode(row: never): infer Row }
  ? Row
  : Spec extends YdbTypeDescriptor
    ? YdbTypeOutput<Spec>
    : Spec extends Readonly<Record<string, YdbTypeDescriptor>>
      ? { [Key in keyof Spec]: YdbTypeOutput<Spec[Key]> }
      : never;
export type YdbYqlResultRows<Results extends YdbYqlResults> = {
  [Key in keyof Results]: ResultRow<Results[Key]>[];
};
export type YdbYqlStatementOptions = Omit<
  YdbQueryRequest,
  'text' | 'parameters' | 'valueMode'
>;
export interface YdbYqlQueryable {
  queryYql(request: YdbQueryRequest): Promise<YdbQueryResult>;
}
export type YdbYqlStatementResult<Results extends YdbYqlResults | undefined> =
  Results extends YdbYqlResults ? YdbYqlResultRows<Results> : YdbQueryResult;
export interface YdbYqlStatement<
  Params extends YdbYqlParams,
  Results extends YdbYqlResults | undefined = undefined,
> {
  (
    target: YdbYqlQueryable,
    values: YdbYqlValues<Params>,
    options?: YdbYqlStatementOptions,
  ): Promise<YdbYqlStatementResult<Results>>;
  readonly text: string;
}

function validateName(name: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
    ['__proto__', 'constructor', 'prototype'].includes(name)
  )
    throw new TypeError(`Invalid YQL statement name: ${name}`);
}

/** Compile parameter types and synchronous result decoders once per statement. */
export function yqlStatement<
  const Params extends YdbYqlParams,
  const Results extends YdbYqlResults | undefined = undefined,
>(definition: {
  readonly params: Params;
  readonly results?: Results;
  readonly text: string;
}): YdbYqlStatement<Params, Results> {
  const code = yqlCode(definition.text).replace(/`(?:``|[^`])*`/g, ' ');
  if (/\bDECLARE\s+\$/i.test(code))
    throw new TypeError(
      'YQL statement text must not contain DECLARE; use params',
    );
  const parameters = Object.entries(definition.params).map(
    ([name, descriptor]) => {
      validateName(name);
      return {
        name,
        descriptor,
        type: descriptor.wireType(),
        encode: descriptor.nativeConversions().encode,
      };
    },
  );
  assertUsedYqlParams(
    definition.text,
    parameters.map(({ name }) => name),
  );
  const names = new Set(parameters.map(({ name }) => name));
  const results =
    definition.results === undefined
      ? undefined
      : Object.entries(definition.results).map(([name, spec]) => {
          validateName(name);
          const decode =
            'decode' in spec && typeof spec.decode === 'function'
              ? spec.decode.bind(spec)
              : 'nativeConversions' in spec &&
                  typeof spec.nativeConversions === 'function'
                ? (
                    (decode, isStruct) =>
                    (row: Readonly<Record<string, unknown>>) => {
                      // Struct descriptors consume the row; scalars consume its single cell.
                      if (isStruct) return decode(row);
                      const keys = Object.keys(row);
                      if (keys.length !== 1)
                        throw new TypeError(
                          'Scalar YQL result requires exactly one column',
                        );
                      return decode(row[keys[0]]);
                    }
                  )(
                    spec.nativeConversions().decode,
                    (spec as YdbTypeDescriptor).wireType().type.case ===
                      'structType',
                  )
                : struct(
                    spec as Readonly<Record<string, YdbTypeDescriptor>>,
                  ).nativeConversions().decode;
          return { name, decode };
        });
  const text = [
    ...parameters.map(
      ({ name, descriptor }) => `DECLARE $${name} AS ${descriptor.yqlType};`,
    ),
    definition.text,
  ].join('\n');
  const query = async (
    target: YdbYqlQueryable,
    values: YdbYqlValues<Params>,
    options: YdbYqlStatementOptions = {},
  ): Promise<YdbYqlStatementResult<Results>> => {
    if (!values || typeof values !== 'object' || Array.isArray(values))
      throw new TypeError('YQL statement parameters require an object');
    for (const name of Object.keys(values))
      if (!names.has(name))
        throw new TypeError(`Unknown YQL parameter: ${name}`);
    const encoded: Record<string, YdbParameter> = {};
    for (const { name, type, encode } of parameters) {
      if (!Object.hasOwn(values, name))
        throw new TypeError(`Missing YQL parameter: ${name}`);
      encoded[name] = { type, value: encode(values[name]) };
    }
    const result = await target.queryYql({
      ...options,
      text,
      parameters: encoded,
      valueMode: 'decoded',
    });
    if (results === undefined) return result as YdbYqlStatementResult<Results>;
    if (result.resultSets.length !== results.length)
      throw new Error(
        `YQL result-set count mismatch: expected ${results.length}, received ${result.resultSets.length}`,
      );
    const decoded: Record<string, unknown> = {};
    for (let index = 0; index < results.length; index++) {
      const { name, decode } = results[index];
      decoded[name] = result.resultSets[index].rows.map((row) => decode(row));
    }
    return decoded as YdbYqlStatementResult<Results>;
  };
  return Object.assign(query, { text });
}

/** Contract-derived column projection, with an optional safely quoted qualifier. */
export function columns(
  model: { readonly columns: readonly Pick<YdbYqlColumn, 'column'>[] },
  alias?: string,
): string {
  return model.columns
    .map(({ column }) => {
      const name = quoteYqlIdentifier(column);
      return alias === undefined
        ? name
        : `${quoteYqlIdentifier(alias)}.${name} AS ${name}`;
    })
    .join(', ');
}
