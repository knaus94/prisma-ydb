import type { YdbParameter } from '../driver/types.js';
import { compileYqlType } from './yql-types.js';
import type {
  YdbYqlQueryable,
  YdbYqlStatementOptions,
} from './yql-statement.js';

export interface YqlTypedMember {
  readonly name: string;
  readonly type: string;
}
export interface YqlFunction<Params, Result> {
  (
    target: YdbYqlQueryable,
    params: Params,
    options?: YdbYqlStatementOptions,
  ): Promise<Result>;
  readonly text: string;
}

/** Generated metadata is compiled once when the generated module is imported. */
export function defineYql<Params, Result>(definition: {
  readonly name: string;
  readonly text: string;
  readonly params: readonly YqlTypedMember[];
  readonly results: readonly (readonly YqlTypedMember[])[];
}): YqlFunction<Params, Result> {
  const parameters = definition.params.map(({ name, type }) => ({
    name,
    ...compileYqlType(type),
  }));
  const names = new Set(parameters.map((p) => p.name));
  if (names.size !== parameters.length)
    throw new TypeError('Duplicate YQL parameter');
  const decoders = definition.results.map(
    (columns) =>
      compileYqlType(
        `Struct<${columns.map(({ name, type }) => `\`${name.replaceAll('`', '``')}\`:${type}`).join(',')}>`,
      ).decode,
  );
  return Object.assign(
    async (
      target: YdbYqlQueryable,
      params: Params,
      options: YdbYqlStatementOptions = {},
    ): Promise<Result> => {
      if (!params || typeof params !== 'object' || Array.isArray(params))
        throw new TypeError('YQL parameters require an object');
      for (const name of Object.keys(params))
        if (!names.has(name))
          throw new TypeError(`Unknown YQL parameter: ${name}`);
      const values = params as Record<string, unknown>;
      const encoded: Record<string, YdbParameter> = Object.create(null);
      for (const { name, type, encode } of parameters) {
        if (!Object.hasOwn(values, name) && type.type.case !== 'optionalType')
          throw new TypeError(`Missing YQL parameter: ${name}`);
        encoded[name] = { type, value: encode(values[name]) };
      }
      const result = await target.queryYql({
        ...options,
        text: definition.text,
        parameters: encoded,
        valueMode: 'decoded',
      });
      if (result.resultSets.length !== decoders.length)
        throw new Error(
          `${definition.name}: YQL result-set count mismatch: expected ${decoders.length}, received ${result.resultSets.length}`,
        );
      if (!decoders.length) return undefined as Result;
      if (decoders.length === 1)
        return result.resultSets[0].rows.map(decoders[0]) as Result;
      return result.resultSets.map((set, index) =>
        set.rows.map(decoders[index]),
      ) as Result;
    },
    { text: definition.text },
  );
}
