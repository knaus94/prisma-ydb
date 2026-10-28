import type {
  StorageTable,
  SqlStorage,
} from '@prisma/orm-family-sql/contract/types';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type {
  YdbParameter,
  YdbQueryRequest,
  YdbQueryResult,
} from '../driver/types.js';
import { nativeCodecConversions, yqlTypeForCodec } from './codecs.js';
import { resolveModel, type ModelColumn } from './model.js';
import { Uint64 } from '@ydbjs/value/primitive';
import { parameterType } from '../driver/values.js';
import { quoteYqlIdentifier } from './compiler.js';
import {
  yqlModel,
  type YdbModelName,
  type YdbYqlInput,
  type YdbYqlOutput,
} from './yql-model.js';

/**
 * How YDB can look `columns` up on `table`: `'primary'` when they prefix the
 * primary key, the name of a secondary index they prefix, or undefined when
 * only a scan remains. Equality on a key prefix is what makes lookups cheap.
 */
export function keyPathFor(
  table: StorageTable | undefined,
  columns: readonly string[],
): string | undefined {
  if (!table || !columns.length) return undefined;
  if (
    columns.every(
      (column, index) => table.primaryKey?.columns[index] === column,
    )
  )
    return 'primary';
  return table.indexes.find(
    (index) =>
      !index.where &&
      columns.every((column, position) => index.columns?.[position] === column),
  )?.name;
}

/** The secondary index to read through, if lookups need one at all. */
export function lookupIndex(
  table: StorageTable | undefined,
  columns: readonly string[],
): string | undefined {
  const path = keyPathFor(table, columns);
  return path === 'primary' ? undefined : path;
}

export interface YdbIndexScanOptions<
  Input,
  Output,
  Field extends keyof Output & string = keyof Output & string,
> {
  readonly index: string;
  /** Equality on a nonempty leading prefix of the index, using model fields. */
  readonly equal: Partial<Input>;
  /** Remaining index fields, then the primary-key tail, returned by lastKey. */
  readonly after?: Partial<Input>;
  readonly budget: number;
  readonly direction?: 'asc' | 'desc';
  readonly select?: readonly Field[];
  /** Synchronous residual filter, run only on the bounded, selected rows. */
  readonly accept?: (row: Pick<Output, Field>) => boolean;
  readonly signal?: AbortSignal;
}
export interface YdbIndexScanResult<Row, Input> {
  readonly rows: Row[];
  readonly inspected: number;
  readonly lastKey: Partial<Input> | undefined;
  /** False when the budget was filled; the next page may still be empty. */
  readonly exhausted: boolean;
}

interface IndexScanPlan {
  readonly text: string;
  readonly equal: readonly string[];
  readonly cursor: readonly {
    field: string;
    column: string;
    decode(value: unknown): unknown;
  }[];
  readonly bindings: readonly {
    field: string;
    after: boolean;
    name: string;
    encode(value: unknown): YdbParameter;
  }[];
  readonly decode: (row: Readonly<Record<string, unknown>>) => unknown;
}
const indexScanPlans = new WeakMap<
  Contract<SqlStorage>,
  Map<string, IndexScanPlan>
>();

function compileIndexScan(
  contract: Contract<SqlStorage>,
  name: string,
  indexName: string,
  prefix: number,
  hasAfter: boolean,
  direction: 'asc' | 'desc',
  selected: readonly string[],
): IndexScanPlan {
  const model = resolveModel(contract, name);
  const index = model.definition.indexes.find(
    (index) => index.name === indexName,
  );
  if (!index || index.where || !index.columns?.length)
    throw new TypeError(
      `Unknown or unsupported YDB index ${indexName} on ${name}`,
    );
  const indexColumns = index.columns.map((name) => {
    const column = model.byColumn.get(name);
    if (!column || column.nullable || column.many)
      throw new TypeError(
        'scanIndex requires mapped nonnullable scalar index columns',
      );
    return column;
  });
  if (!prefix || prefix > indexColumns.length)
    throw new TypeError(
      'scanIndex equal must match a nonempty leading index prefix',
    );
  const equal = indexColumns.slice(0, prefix);
  const ordering = [...new Set([...indexColumns, ...model.primaryKey])];
  if (ordering.some((column) => column.nullable || column.many))
    throw new TypeError('scanIndex requires nonnullable scalar keys');
  const cursor = ordering.filter((column) => !equal.includes(column));
  if (hasAfter && !cursor.length)
    throw new TypeError(
      'scanIndex after must contain the remaining index fields and primary-key tail',
    );
  const declarations: string[] = [];
  const bindings: IndexScanPlan['bindings'][number][] = [];
  const bind = (column: ModelColumn, after: boolean) => {
    const name = `k${bindings.length}`;
    const typeName = yqlTypeForCodec(column.codecId, column.typeParams);
    const type = parameterType(typeName);
    const encode = nativeCodecConversions(
      column.codecId,
      column.typeParams,
    ).encode;
    declarations.push(`DECLARE $${name} AS ${typeName};`);
    bindings.push({
      field: column.field,
      after,
      name,
      encode: (value) => ({ type, value: encode(value) }),
    });
    return `$${name}`;
  };
  const predicates = equal.map(
    (column) => `${quoteYqlIdentifier(column.column)} = ${bind(column, false)}`,
  );
  if (hasAfter) {
    const left = cursor.map((column) => quoteYqlIdentifier(column.column));
    const right = cursor.map((column) => bind(column, true));
    const tuple = (parts: string[]) =>
      parts.length === 1 ? parts[0] : `AsTuple(${parts.join(', ')})`;
    predicates.push(
      `${tuple(left)} ${direction === 'asc' ? '>' : '<'} ${tuple(right)}`,
    );
  }
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((field) => !model.byField.has(field))
  )
    throw new TypeError('scanIndex select requires unique model fields');
  const transferred = [
    ...new Set([...selected, ...cursor.map((column) => column.field)]),
  ];
  const columns = transferred.map((field) =>
    quoteYqlIdentifier(model.byField.get(field)!.column),
  );
  const text = [
    ...declarations,
    'DECLARE $budget AS Uint64;',
    `SELECT ${columns.join(', ')} FROM ${quoteYqlIdentifier(model.table)} VIEW ${quoteYqlIdentifier(indexName)} WHERE ${predicates.join(' AND ')} ORDER BY ${ordering.map((column) => `${quoteYqlIdentifier(column.column)} ${direction.toUpperCase()}`).join(', ')} LIMIT $budget;`,
  ].join('\n');
  const decoder = yqlModel(contract, name, { fields: selected });
  return {
    text,
    bindings,
    equal: equal.map((column) => column.field),
    decode: decoder.decode,
    cursor: cursor.map((column) => {
      const decode = nativeCodecConversions(
        column.codecId,
        column.typeParams,
      ).decode;
      return {
        field: column.field,
        column: column.column,
        decode:
          column.codecId === 'ydb/timestamp@1'
            ? (value) => (typeof value === 'bigint' ? value : decode(value))
            : decode,
      };
    }),
  };
}

/** Scan at most budget index entries before evaluating a client-side residual. */
export async function scanModelIndex<
  C extends Contract<SqlStorage>,
  Name extends YdbModelName<C>,
  Field extends keyof YdbYqlOutput<C, Name> & string,
>(
  target: { queryYql(request: YdbQueryRequest): Promise<YdbQueryResult> },
  contract: C,
  name: Name,
  options: YdbIndexScanOptions<
    YdbYqlInput<C, Name>,
    YdbYqlOutput<C, Name>,
    Field
  >,
): Promise<
  YdbIndexScanResult<Pick<YdbYqlOutput<C, Name>, Field>, YdbYqlInput<C, Name>>
> {
  if (!Number.isSafeInteger(options.budget) || options.budget < 1)
    throw new TypeError('scanIndex budget must be a positive safe integer');
  const direction = options.direction ?? 'asc';
  if (direction !== 'asc' && direction !== 'desc')
    throw new TypeError('scanIndex direction must be asc or desc');
  const equal = options.equal as Readonly<Record<string, unknown>>;
  if (!equal || typeof equal !== 'object' || Array.isArray(equal))
    throw new TypeError('scanIndex equal must be an index prefix object');
  const prefix = Object.keys(equal).length;
  const selected =
    options.select ??
    resolveModel(contract, name).columns.map((column) => column.field);
  let plans = indexScanPlans.get(contract);
  if (!plans) indexScanPlans.set(contract, (plans = new Map()));
  const cacheKey = JSON.stringify([
    name,
    options.index,
    prefix,
    options.after !== undefined,
    direction,
    selected,
  ]);
  let plan = plans.get(cacheKey);
  if (!plan) {
    plan = compileIndexScan(
      contract,
      name,
      options.index,
      prefix,
      options.after !== undefined,
      direction,
      selected,
    );
    if (plans.size >= 256) plans.delete(plans.keys().next().value!);
    plans.set(cacheKey, plan);
  }
  if (plan.equal.some((field) => !Object.hasOwn(equal, field)))
    throw new TypeError(
      'scanIndex equal must match a nonempty leading index prefix',
    );
  const after = options.after as Readonly<Record<string, unknown>> | undefined;
  if (
    after !== undefined &&
    (!after ||
      typeof after !== 'object' ||
      Array.isArray(after) ||
      Object.keys(after).length !== plan.cursor.length ||
      plan.cursor.some(({ field }) => !Object.hasOwn(after, field)))
  )
    throw new TypeError(
      'scanIndex after must contain the remaining index fields and primary-key tail',
    );
  const parameters: Record<string, YdbParameter> = {
    budget: new Uint64(BigInt(options.budget)),
  };
  for (const binding of plan.bindings) {
    const value = (binding.after ? after! : equal)[binding.field];
    if (value === null || value === undefined)
      throw new TypeError(`scanIndex key ${binding.field} cannot be null`);
    parameters[binding.name] = binding.encode(value);
  }
  const result = await target.queryYql({
    text: plan.text,
    parameters,
    valueMode: 'decoded',
    signal: options.signal,
  });
  const scanned = result.resultSets[0]?.rows ?? [];
  const rows: Pick<YdbYqlOutput<C, Name>, Field>[] = [];
  for (const raw of scanned) {
    const row = plan.decode(raw) as Pick<YdbYqlOutput<C, Name>, Field>;
    if (options.accept === undefined || options.accept(row)) rows.push(row);
  }
  let lastKey: Partial<YdbYqlInput<C, Name>> | undefined;
  const last = scanned.at(-1);
  if (last) {
    const key: Record<string, unknown> = {};
    for (const column of plan.cursor)
      key[column.field] = column.decode(last[column.column]);
    lastKey = key as Partial<YdbYqlInput<C, Name>>;
  }
  return {
    rows,
    inspected: scanned.length,
    lastKey,
    exhausted: scanned.length < options.budget,
  };
}
