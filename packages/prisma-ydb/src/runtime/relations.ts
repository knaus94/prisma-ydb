import { runtimeError } from '@prisma/orm-framework/components/runtime';
import {
  AndExpr,
  ColumnRef,
  NullCheckExpr,
  ProjectionItem,
  SubqueryExpr,
  WindowFuncExpr,
  type AnyExpression,
  type AnyFromSource,
  type AnyJsonValueProjection,
  type ExistsExpr,
  type JsonArrayAggExpr,
  type JsonObjectExpr,
  type OrderByItem,
  type SelectAst,
} from '@prisma/orm-family-sql/relational-core/ast';

/** Compiler callbacks keep parameter binding and identifier escaping in one place. */
export interface RelationRenderContext {
  expr(expr: AnyExpression): string;
  select(ast: SelectAst): string;
  order(items: readonly OrderByItem[]): string;
  quote(identifier: string): string;
  nextAlias(): string;
}

export interface LoweredRelationIncludes {
  readonly projections: ReadonlyMap<ProjectionItem, string>;
  readonly joins: readonly string[];
}

function unsupported(detail: string): never {
  throw runtimeError(
    'YDB.UNSUPPORTED_RELATION',
    `YDB relation lowering does not support ${detail}`,
    { feature: detail },
  );
}

function sourceAlias(source: AnyFromSource): string | undefined {
  return source.kind === 'table-source'
    ? (source.alias ?? source.name)
    : source.alias;
}

function localAliases(ast: SelectAst): Set<string> {
  return new Set(
    [ast.from, ...(ast.joins ?? []).map((join) => join.source)]
      .filter((source): source is AnyFromSource => source !== undefined)
      .map(sourceAlias)
      .filter((alias): alias is string => alias !== undefined),
  );
}

function ownColumnRefs(expression: AnyExpression): ColumnRef[] {
  return expression.fold<ColumnRef[]>({
    empty: [],
    combine: (left, right) => [...left, ...right],
    columnRef: (column) => [column],
    // Nested subqueries introduce their own scopes; the recursive compiler lowers them.
    select: () => [],
  });
}

/** Distinguish self-contained subqueries from unsupported correlated wrappers. */
function hasOuterReference(
  ast: SelectAst,
  ancestors: ReadonlySet<string> = new Set(),
): boolean {
  const scope = new Set([...ancestors, ...localAliases(ast)]);
  const expressionHasOuterReference = (expression: AnyExpression): boolean =>
    expression.fold<boolean>({
      empty: false,
      combine: (left, right) => left || right,
      isAbsorbing: (value) => value,
      columnRef: (column) => !scope.has(column.table),
      select: (query) => hasOuterReference(query, scope),
    });
  const sources = [ast.from, ...(ast.joins ?? []).map((join) => join.source)];
  if (
    sources.some((source) =>
      source?.kind === 'derived-table-source'
        ? hasOuterReference(source.query, scope)
        : source?.kind === 'function-source' &&
          source.args.some(expressionHasOuterReference),
    )
  )
    return true;
  const expressions = [
    ...ast.projection.map((item) => item.expr),
    ast.where,
    ast.having,
    ...(ast.orderBy ?? []).map((item) => item.expr),
    ...(ast.groupBy ?? []),
    ...(ast.distinctOn ?? []),
    ...(ast.joins ?? []).flatMap((join) =>
      join.on.kind === 'eq-col-join-on'
        ? [join.on.left, join.on.right]
        : [join.on],
    ),
  ];
  return expressions.some(
    (expression) =>
      expression !== undefined && expressionHasOuterReference(expression),
  );
}

interface Correlation {
  readonly pairs: readonly {
    readonly child: ColumnRef;
    readonly parent: ColumnRef;
  }[];
  readonly predicate: AnyExpression | undefined;
}

/** Extract only conjunctions of equality keys. Arbitrary correlations must fail explicitly. */
function splitCorrelation(ast: SelectAst): Correlation {
  const aliases = localAliases(ast);
  const pairs: { child: ColumnRef; parent: ColumnRef }[] = [];
  const rest: AnyExpression[] = [];
  const visit = (expression: AnyExpression): void => {
    if (expression.kind === 'and') {
      expression.exprs.forEach(visit);
      return;
    }
    if (
      expression.kind === 'binary' &&
      expression.op === 'eq' &&
      expression.left.kind === 'column-ref' &&
      expression.right.kind === 'column-ref'
    ) {
      const leftLocal = aliases.has(expression.left.table);
      const rightLocal = aliases.has(expression.right.table);
      if (leftLocal !== rightLocal) {
        pairs.push(
          leftLocal
            ? { child: expression.left, parent: expression.right }
            : { child: expression.right, parent: expression.left },
        );
        return;
      }
    }
    if (ownColumnRefs(expression).some((column) => !aliases.has(column.table)))
      unsupported('non-equality or disjunctive correlated predicates');
    rest.push(expression);
  };
  if (ast.where) visit(ast.where);
  return { pairs, predicate: rest.length ? AndExpr.of(rest) : undefined };
}

function jsonProjection(
  projection: AnyJsonValueProjection,
  context: RelationRenderContext,
): string {
  const rendered = context.expr(projection.value);
  if (projection.kind !== 'codec') return rendered;
  if (projection.codec.many) unsupported('stored scalar-list JSON projections');
  switch (projection.codec.codecId) {
    case 'ydb/utf8@1':
    case 'ydb/int32@1':
    case 'ydb/bool@1':
    case 'ydb/double@1':
    case 'ydb/json@1':
      return rendered;
    case 'ydb/int64@1':
    case 'ydb/uint64@1':
    case 'ydb/number@1':
    case 'ydb/decimal@1':
      return `CAST(${rendered} AS Utf8)`;
    case 'ydb/timestamp@1':
      return `CAST(DateTime::Format("%Y-%m-%dT%H:%M:%SZ")(${rendered}) AS Utf8)`;
    case 'ydb/string@1':
      return `CAST(String::Base64Encode(${rendered}) AS Utf8)`;
    default:
      return unsupported(
        `include JSON encoding for codec ${projection.codec.codecId}`,
      );
  }
}

/** Native typed structs/lists satisfy Prisma's already-decoded JSON include contract. */
export function renderYdbJson(
  expression: JsonObjectExpr | JsonArrayAggExpr,
  context: RelationRenderContext,
): string {
  if (expression.kind === 'json-object') {
    return `AsStruct(${expression.entries.map((entry) => `${jsonProjection(entry.value, context)} AS ${context.quote(entry.key)}`).join(', ')})`;
  }
  if (expression.orderBy?.length)
    unsupported('standalone ordered JSON aggregates; use relation includes');
  const aggregate = `AGGREGATE_LIST(${jsonProjection(expression.expr, context)})`;
  return expression.onEmpty === 'null'
    ? `IF(COUNT(*) = 0, NULL, ${aggregate})`
    : aggregate;
}

function limitSql(
  value: number | AnyExpression,
  context: RelationRenderContext,
): string {
  return typeof value === 'number'
    ? `${value}ul`
    : `CAST(${context.expr(value)} AS Uint64)`;
}

function scalarEnvelope(expression: AnyExpression): boolean {
  return (
    expression.kind === 'json-object' &&
    expression.entries.length === 1 &&
    expression.entries[0].key === 'value' &&
    expression.entries[0].value.kind === 'codec' &&
    expression.entries[0].value.value.kind === 'aggregate'
  );
}

function checkAggregateShape(aggregate: SelectAst): void {
  if (
    aggregate.distinct ||
    aggregate.distinctOn?.length ||
    aggregate.groupBy?.length ||
    aggregate.having ||
    aggregate.limit !== undefined ||
    aggregate.offset !== undefined ||
    aggregate.locking?.length
  )
    unsupported('modified relation aggregate envelopes');
}

/**
 * Lift Prisma's correlated row-include subquery into a grouped LEFT JOIN. Each
 * relation is aggregated before joining, so parent cardinality/pagination is preserved.
 */
export function lowerRelationIncludes(
  ast: SelectAst,
  context: RelationRenderContext,
): LoweredRelationIncludes {
  const projections = new Map<ProjectionItem, string>();
  const joins: string[] = [];
  const outerAliases = localAliases(ast);
  for (const projection of ast.projection) {
    if (projection.expr.kind !== 'subquery') continue;
    const aggregate = projection.expr.query;
    if (aggregate.projection.length !== 1) continue;
    const envelope = aggregate.projection[0].expr;
    // combine() packs separately shaped row/reducer branches into one document.
    if (envelope.kind === 'json-object' && !scalarEnvelope(envelope)) {
      const branches = [
        aggregate.from,
        ...(aggregate.joins ?? []).map((join) => join.source),
      ];
      if (
        envelope.entries.every(
          (entry) =>
            entry.value.kind === 'document' &&
            entry.value.value.kind === 'column-ref',
        )
      ) {
        checkAggregateShape(aggregate);
        if (
          aggregate.where ||
          aggregate.joins?.some(
            (join) =>
              join.joinType !== 'inner' ||
              join.lateral ||
              join.on.kind !== 'and' ||
              join.on.exprs.length,
          )
        )
          unsupported('modified combine relation envelopes');
        const values = envelope.entries.map((entry) => {
          const column = entry.value.value as ColumnRef;
          const branch = branches.find(
            (source) =>
              source?.kind === 'derived-table-source' &&
              source.alias === column.table,
          );
          if (
            branch?.kind !== 'derived-table-source' ||
            branch.query.projection.length !== 1 ||
            branch.query.projection[0].alias !== column.column
          )
            unsupported('unknown combine relation branch');
          const item = ProjectionItem.of(
            entry.key,
            SubqueryExpr.of(branch.query),
          );
          const lowered = lowerRelationIncludes(
            ast.withProjection([item]),
            context,
          );
          const value = lowered.projections.get(item);
          if (!value)
            unsupported('uncorrelated or unsupported combine relation branch');
          joins.push(...lowered.joins);
          return `${value} AS ${context.quote(entry.key)}`;
        });
        projections.set(projection, `AsStruct(${values.join(', ')})`);
        continue;
      }
    }
    if (
      envelope.kind === 'json-object' &&
      scalarEnvelope(envelope) &&
      aggregate.from?.kind !== 'derived-table-source'
    ) {
      checkAggregateShape(aggregate);
      const correlation = splitCorrelation(aggregate);
      if (!correlation.pairs.length) continue;
      if (
        correlation.pairs.some((pair) => !outerAliases.has(pair.parent.table))
      )
        unsupported(
          'relation reducers correlated across more than one query level',
        );
      const groupedAlias = context.nextAlias();
      const keys = correlation.pairs.map(() => context.nextAlias());
      const valueAlias = context.nextAlias();
      const grouped = aggregate
        .withWhere(correlation.predicate)
        .withOrderBy([])
        .withProjection([
          ProjectionItem.of(valueAlias, envelope),
          ...correlation.pairs.map((pair, index) =>
            ProjectionItem.of(keys[index], pair.child),
          ),
        ])
        .withGroupBy(correlation.pairs.map((pair) => pair.child));
      const on = correlation.pairs
        .map(
          (pair, index) =>
            `${context.expr(pair.parent)} = ${context.quote(groupedAlias)}.${context.quote(keys[index])}`,
        )
        .join(' AND ');
      joins.push(
        ` LEFT JOIN (${context.select(grouped)}) AS ${context.quote(groupedAlias)} ON ${on}`,
      );
      // The generic SQL runtime turns a NULL subquery document into []. Keep the
      // scalar envelope present even for absent groups; its codec owns defaults.
      projections.set(
        projection,
        `AsStruct(${context.quote(groupedAlias)}.${context.quote(valueAlias)}.value AS value)`,
      );
      continue;
    }
    if (
      (envelope.kind !== 'json-array-agg' &&
        (envelope.kind !== 'json-object' || !scalarEnvelope(envelope))) ||
      aggregate.from?.kind !== 'derived-table-source'
    )
      continue;
    checkAggregateShape(aggregate);
    if (aggregate.joins?.length || aggregate.where)
      unsupported('modified row-include aggregate envelopes');
    const isRows = envelope.kind === 'json-array-agg';
    const rowsAlias = aggregate.from.alias;
    const child = aggregate.from.query;
    if (
      child.distinct ||
      child.distinctOn?.length ||
      child.groupBy?.length ||
      child.having ||
      child.locking?.length
    )
      unsupported('distinct/grouped/locked relation includes');
    if (isRows && !!envelope.orderBy?.length !== !!child.orderBy?.length)
      unsupported(
        'relation aggregate ordering that differs from its child row ordering',
      );
    const correlation = splitCorrelation(child);
    if (!correlation.pairs.length) continue;
    if (correlation.pairs.some((pair) => !outerAliases.has(pair.parent.table)))
      unsupported(
        'relation includes correlated across more than one query level',
      );

    const groupedAlias = context.nextAlias();
    const keys = correlation.pairs.map(() => context.nextAlias());
    const rankAlias = context.nextAlias();
    const listAlias = context.nextAlias();
    const needsRank =
      (isRows && !!child.orderBy?.length) ||
      child.limit !== undefined ||
      child.offset !== undefined;
    const addedProjection = correlation.pairs.map((pair, index) =>
      ProjectionItem.of(keys[index], pair.child),
    );
    if (needsRank)
      addedProjection.push(
        ProjectionItem.of(
          rankAlias,
          WindowFuncExpr.rowNumber({
            partitionBy: correlation.pairs.map((pair) => pair.child),
            orderBy: child.orderBy,
          }),
        ),
      );
    const uncorrelated = child
      .withWhere(correlation.predicate)
      .withLimit(undefined)
      .withOffset(undefined)
      .withOrderBy([])
      .withProjection([...child.projection, ...addedProjection]);
    const childSql = context.select(uncorrelated);
    const keySql = keys.map(
      (key) => `${context.quote(rowsAlias)}.${context.quote(key)}`,
    );
    const payload = isRows
      ? jsonProjection(envelope.expr, context)
      : context.expr(envelope);
    let list = isRows ? `AGGREGATE_LIST(${payload})` : payload;
    let filter = '';
    if (needsRank) {
      const rank = `${context.quote(rowsAlias)}.${context.quote(rankAlias)}`;
      if (isRows) {
        const sorted = `ListSortAsc(AGGREGATE_LIST(AsStruct(${rank} AS rank, ${payload} AS payload)), ($item) -> ($item.rank))`;
        list = `ListMap(${sorted}, ($item) -> ($item.payload))`;
      }
      const bounds: string[] = [];
      const offset =
        child.offset === undefined ? '0ul' : limitSql(child.offset, context);
      if (child.offset !== undefined) bounds.push(`${rank} > ${offset}`);
      if (child.limit !== undefined)
        bounds.push(`${rank} - ${offset} <= ${limitSql(child.limit, context)}`);
      if (bounds.length) filter = ` WHERE ${bounds.join(' AND ')}`;
    }
    const grouped = `SELECT ${keySql.map((key, index) => `${key} AS ${context.quote(keys[index])}`).join(', ')}, ${list} AS ${context.quote(listAlias)} FROM (${childSql}) AS ${context.quote(rowsAlias)}${filter} GROUP BY ${keySql.join(', ')}`;
    const on = correlation.pairs
      .map(
        (pair, index) =>
          `${context.expr(pair.parent)} = ${context.quote(groupedAlias)}.${context.quote(keys[index])}`,
      )
      .join(' AND ');
    joins.push(
      ` LEFT JOIN (${grouped}) AS ${context.quote(groupedAlias)} ON ${on}`,
    );
    // Missing children produce NULL; the SQL-family include decoder maps that to [].
    const result = `${context.quote(groupedAlias)}.${context.quote(listAlias)}`;
    projections.set(
      projection,
      isRows ? result : `AsStruct(${result}.value AS value)`,
    );
  }
  for (const projection of ast.projection) {
    if (
      !projections.has(projection) &&
      projection.expr.kind === 'subquery' &&
      hasOuterReference(projection.expr.query)
    ) {
      unsupported(
        'this correlated subquery shape, including distinct relation includes',
      );
    }
  }
  return { projections, joins };
}

/** some/none/every become an uncorrelated key-membership query with SQL NULL semantics. */
export function renderYdbExists(
  expression: ExistsExpr,
  context: RelationRenderContext,
): string | undefined {
  const subquery = expression.subquery;
  const correlation = splitCorrelation(subquery);
  if (!correlation.pairs.length) {
    if (hasOuterReference(subquery))
      unsupported('correlated EXISTS wrapped in derived queries');
    return undefined;
  }
  if (
    subquery.groupBy?.length ||
    subquery.having ||
    subquery.offset !== undefined ||
    subquery.locking?.length
  )
    unsupported('grouped/offset correlated EXISTS');
  if (
    subquery.projection.some(
      (item) => item.expr.kind !== 'literal' && item.expr.kind !== 'column-ref',
    )
  )
    unsupported('computed or aggregate projections in correlated EXISTS');
  if (subquery.limit !== undefined && typeof subquery.limit !== 'number')
    unsupported('parameterized correlated EXISTS limits');
  if (subquery.limit === 0) return expression.notExists ? 'TRUE' : 'FALSE';
  const keyAlias = context.nextAlias();
  const parentParts = correlation.pairs.map((pair) =>
    context.expr(pair.parent),
  );
  const tuple = (parts: string[]): string =>
    parts.length === 1 ? parts[0] : `AsTuple(${parts.join(', ')})`;
  const nullSafe = AndExpr.of([
    ...(correlation.predicate ? [correlation.predicate] : []),
    ...correlation.pairs.map((pair) => NullCheckExpr.isNotNull(pair.child)),
  ]);
  const query = subquery
    .withWhere(nullSafe)
    .withLimit(undefined)
    .withOrderBy([]);
  // Render keys with one projection without fabricating a target codec.
  let selection = context.select(
    query.withProjection(
      correlation.pairs.map((pair, index) =>
        ProjectionItem.of(`${keyAlias}_${index}`, pair.child),
      ),
    ),
  );
  // YQL IN subqueries have exactly one output column, including composite keys.
  if (correlation.pairs.length > 1) {
    const source = context.nextAlias();
    const values = correlation.pairs.map(
      (_, index) =>
        `${context.quote(source)}.${context.quote(`${keyAlias}_${index}`)}`,
    );
    selection = `SELECT AsTuple(${values.join(', ')}) AS ${context.quote(keyAlias)} FROM (${selection}) AS ${context.quote(source)}`;
  }
  const parent = tuple(parentParts);
  const membership = `COALESCE(${parent} IN (${selection}), FALSE)`;
  return expression.notExists ? `(NOT ${membership})` : membership;
}
