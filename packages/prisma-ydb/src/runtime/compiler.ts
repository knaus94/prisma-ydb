import type { Contract } from '@prisma/orm-framework/contract/types';
import { runtimeError } from '@prisma/orm-framework/components/runtime';
import type {
  SqlStorage,
  StorageTable,
} from '@prisma/orm-family-sql/contract/types';
import {
  collectOrderedParamRefs,
  type AnyExpression,
  type AnyFromSource,
  type AnyParamRef,
  type AnyQueryAst,
  type InsertAst,
  type LoweredStatement,
  type OrderByItem,
  type ProjectionItem,
  type SelectAst,
  type TableSource,
} from '@prisma/orm-family-sql/relational-core/ast';
import type { Value } from '@ydbjs/value';
import { typeToString } from '@ydbjs/value/print';
import { yqlTypeForCodec } from './codecs.js';
import { ReferentialProgram } from './referential.js';
import {
  lowerRelationIncludes,
  renderYdbExists,
  renderYdbJson,
  type RelationRenderContext,
} from './relations.js';

export function unsupported(feature: string): never {
  throw runtimeError(
    'YDB.UNSUPPORTED_FEATURE',
    `YDB does not support ${feature} through this adapter`,
    { feature },
  );
}
export function quoteYqlIdentifier(identifier: string): string {
  if (!identifier || /[\0\r\n]/.test(identifier))
    throw new TypeError('Invalid YQL identifier');
  return '`' + identifier.replaceAll('\\', '\\\\').replaceAll('`', '\\`') + '`';
}
function literal(value: unknown): string {
  if (value === null) return 'NULL';
  if (typeof value === 'string') return JSON.stringify(value) + 'u';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'bigint') return `${value}l`;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return `Timestamp(${JSON.stringify(value.toISOString())})`;
  return unsupported('inline values of this type; use a typed parameter');
}
function literalDefault(
  value: unknown,
  codecId: string,
  typeParams?: unknown,
  many = false,
): string {
  const type = many ? 'Json' : yqlTypeForCodec(codecId, typeParams);
  if (type === 'Json' || type === 'JsonDocument') {
    const encoded = JSON.stringify(value);
    if (encoded === undefined)
      throw new TypeError('JSON defaults require a JSON value');
    return `${type}(${JSON.stringify(encoded)})`;
  }
  return `CAST(${literal(value)} AS ${type})`;
}
function isValue(value: unknown): value is Value {
  return (
    typeof value === 'object' &&
    value !== null &&
    'encode' in value &&
    typeof value.encode === 'function' &&
    'type' in value
  );
}
export function inferYqlParameterType(
  ref: AnyParamRef,
  listColumn = false,
): string {
  const codec = ref.codec;
  let type: string;
  if (codec)
    type = listColumn
      ? 'Json'
      : yqlTypeForCodec(codec.codecId, codec.typeParams);
  else if (ref.kind === 'prepared-param-ref')
    return unsupported('untyped prepared parameters');
  else if (isValue(ref.value)) return typeToString(ref.value.type);
  else {
    switch (typeof ref.value) {
      case 'string':
        type = 'Utf8';
        break;
      case 'number':
        type = Number.isInteger(ref.value) ? 'Int64' : 'Double';
        break;
      case 'bigint':
        type = 'Int64';
        break;
      case 'boolean':
        type = 'Bool';
        break;
      default:
        return unsupported(
          'untyped null/object parameters; supply an explicit YDB codec',
        );
    }
  }
  if (codec?.many && !listColumn) type = `List<${type}>`;
  if (ref.kind === 'prepared-param-ref' ? ref.nullable : ref.value === null)
    type += '?';
  return type;
}

const operators = {
  eq: '=',
  neq: '<>',
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
  like: 'LIKE',
  in: 'IN',
  notIn: 'NOT IN',
  isNotDistinctFrom: 'IS NOT DISTINCT FROM',
  isDistinctFrom: 'IS DISTINCT FROM',
} as const;

const functions: Record<string, string> = {
  coalesce: 'COALESCE',
  lower: 'Unicode::ToLower',
  upper: 'Unicode::ToUpper',
  length: 'LENGTH',
  abs: 'ABS',
  round: 'Math::Round',
  floor: 'Math::Floor',
  ceil: 'Math::Ceil',
};

class YqlCompiler {
  readonly refs;
  readonly indices;
  private mutationTable: string | undefined;
  private aliasCounter = 0;
  private reservedIdentifiers: Set<string> | undefined;
  private readonly defaultNamespace: string | undefined;
  resultColumns: readonly (readonly [string, string])[] | undefined;
  constructor(
    private readonly contract: Contract<SqlStorage>,
    private readonly ast: AnyQueryAst,
  ) {
    this.refs = collectOrderedParamRefs(ast);
    this.indices = new Map(this.refs.map((ref, index) => [ref, index + 1]));
    const namespaces = Object.keys(contract.storage.namespaces);
    this.defaultNamespace = namespaces.length === 1 ? namespaces[0] : undefined;
  }
  private reserveIdentifiers(): Set<string> {
    if (this.reservedIdentifiers) return this.reservedIdentifiers;
    const identifiers = new Set<string>();
    const visited = new WeakSet<object>();
    const reserve = (value: unknown): void => {
      if (typeof value === 'string') {
        identifiers.add(value);
        return;
      }
      if (typeof value !== 'object' || value === null || visited.has(value))
        return;
      if (
        ArrayBuffer.isView(value) ||
        ('kind' in value &&
          (value.kind === 'param-ref' || value.kind === 'prepared-param-ref'))
      )
        return;
      visited.add(value);
      Object.values(value).forEach(reserve);
    };
    reserve(this.ast);
    this.reservedIdentifiers = identifiers;
    return identifiers;
  }
  private relationContext(): RelationRenderContext {
    return {
      expr: (value) => this.expr(value),
      select: (ast) => this.select(ast),
      order: (items) => this.order(items),
      quote: quoteYqlIdentifier,
      nextAlias: () => {
        const identifiers = this.reserveIdentifiers();
        let alias: string;
        do {
          alias = `__prisma_ydb_relation_${++this.aliasCounter}`;
        } while (identifiers.has(alias));
        identifiers.add(alias);
        return alias;
      },
    };
  }
  table(source: TableSource): string {
    const namespaceId = source.namespaceId ?? this.defaultNamespace;
    const namespace = namespaceId
      ? this.contract.storage.namespaces[namespaceId]
      : undefined;
    if (!namespace)
      throw new TypeError(`Unknown YDB namespace: ${namespaceId}`);
    // YDB has database-relative paths, not PostgreSQL schemas. The native namespace owns qualification.
    return namespace.qualifyTable
      ? namespace.qualifyTable(source.name)
      : quoteYqlIdentifier(source.name);
  }
  tableDefinition(source: TableSource): StorageTable {
    const namespaceId = source.namespaceId ?? this.defaultNamespace;
    const table = namespaceId
      ? this.contract.storage.namespaces[namespaceId]?.entries.table?.[
          source.name
        ]
      : undefined;
    if (!table) throw new TypeError(`Unknown YDB table: ${source.name}`);
    return table;
  }
  source(source: AnyFromSource): string {
    switch (source.kind) {
      case 'table-source':
        return (
          this.table(source) +
          (source.alias ? ` AS ${quoteYqlIdentifier(source.alias)}` : '')
        );
      case 'derived-table-source':
        return `(${this.select(source.query)}) AS ${quoteYqlIdentifier(source.alias)}`;
      case 'function-source':
        return unsupported('SQL table-valued function sources; use native YQL');
    }
  }
  expr(expr: AnyExpression): string {
    const render = (value: AnyExpression) => this.expr(value);
    switch (expr.kind) {
      case 'column-ref':
        return this.mutationTable === expr.table
          ? quoteYqlIdentifier(expr.column)
          : `${quoteYqlIdentifier(expr.table)}.${quoteYqlIdentifier(expr.column)}`;
      case 'identifier-ref':
        return quoteYqlIdentifier(expr.name);
      case 'param-ref':
      case 'prepared-param-ref': {
        const index = this.indices.get(expr);
        if (!index) throw new TypeError('Parameter is missing from AST');
        return `$p${index}`;
      }
      case 'literal':
        return literal(expr.value);
      case 'subquery':
        return `(${this.select(expr.query)})`;
      case 'binary': {
        if (
          (expr.op === 'in' || expr.op === 'notIn') &&
          expr.right.kind === 'list' &&
          expr.right.values.length === 0
        )
          return expr.op === 'in' ? 'FALSE' : 'TRUE';
        return `(${render(expr.left)} ${operators[expr.op]} ${render(expr.right)})`;
      }
      case 'and':
        return expr.exprs.length
          ? `(${expr.exprs.map(render).join(' AND ')})`
          : 'TRUE';
      case 'or':
        return expr.exprs.length
          ? `(${expr.exprs.map(render).join(' OR ')})`
          : 'FALSE';
      case 'not':
        return `(NOT ${render(expr.expr)})`;
      case 'null-check':
        return `(${render(expr.expr)} IS ${expr.isNull ? '' : 'NOT '}NULL)`;
      case 'exists':
        return (
          renderYdbExists(expr, this.relationContext()) ??
          `${expr.notExists ? 'NOT ' : ''}EXISTS(${this.select(expr.subquery)})`
        );
      case 'list':
        return `(${expr.values.map(render).join(', ')})`;
      case 'raw-expr':
        return expr.parts
          .map((part) => (typeof part === 'string' ? part : render(part)))
          .join('');
      case 'aggregate':
        return `${expr.fn.toUpperCase()}(${expr.expr ? render(expr.expr) : '*'})`;
      case 'cast': {
        if (
          !/^(?:Bool|Int(?:8|16|32|64)|Uint(?:8|16|32|64)|Float|Double|Utf8|String|Json|JsonDocument|Date|Datetime|Timestamp|Interval|Decimal\((?:[1-9]|[12]\d|3[0-5]),\s*\d{1,2}\))\??$/.test(
            expr.targetType,
          )
        )
          return unsupported(`cast to ${expr.targetType}`);
        return `CAST(${render(expr.expr)} AS ${expr.targetType})`;
      }
      case 'function-call': {
        const fn = functions[expr.fn.toLowerCase()];
        if (!fn)
          return unsupported(
            `function ${expr.fn}; use a native raw YQL expression`,
          );
        return `${fn}(${expr.args.map(render).join(', ')})`;
      }
      case 'operation':
        return expr.lowering.template.replace(
          /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\{\{self\}\}|\{\{arg(\d+)\}\}/g,
          (token, index: string | undefined) => {
            if (token.startsWith('"') || token.startsWith("'")) return token;
            const value =
              token === '{{self}}' ? expr.self : expr.args[Number(index)];
            if (!value)
              throw new TypeError(`Invalid operation template: ${expr.method}`);
            return render(value);
          },
        );
      case 'case':
        return `CASE ${expr.branches.map((branch) => `WHEN ${render(branch.condition)} THEN ${render(branch.value)}`).join(' ')}${expr.elseExpr ? ` ELSE ${render(expr.elseExpr)}` : ''} END`;
      case 'window-func':
        return `${expr.fn.toUpperCase()}(${expr.args.map(render).join(', ')}) OVER (${[expr.partitionBy?.length ? `PARTITION BY ${expr.partitionBy.map(render).join(', ')}` : '', expr.orderBy?.length ? `ORDER BY ${this.order(expr.orderBy)}` : ''].filter(Boolean).join(' ')})`;
      case 'json-object':
      case 'json-array-agg':
        return renderYdbJson(expr, this.relationContext());
    }
  }
  order(items: readonly OrderByItem[]): string {
    return items
      .flatMap((item) => {
        const expression = this.expr(item.expr);
        // YQL has no NULLS FIRST/LAST clause. Order by a nullness key first.
        return [
          ...(item.nulls
            ? [
                `(${expression} IS NULL) ${item.nulls === 'first' ? 'DESC' : 'ASC'}`,
              ]
            : []),
          `${expression} ${item.dir.toUpperCase()}`,
        ];
      })
      .join(', ');
  }
  projection(items: readonly ProjectionItem[]): string {
    return items
      .map(
        (item) =>
          `${this.expr(item.expr)} AS ${quoteYqlIdentifier(item.alias)}`,
      )
      .join(', ');
  }
  select(ast: SelectAst): string {
    if (ast.locking?.length)
      return unsupported(
        'explicit row locks; YDB uses optimistic serializable transactions',
      );
    if (ast.distinctOn?.length)
      return unsupported('DISTINCT ON; use distinct()/window functions');
    const relations = lowerRelationIncludes(ast, this.relationContext());
    const projection = ast.projection
      .map(
        (item) =>
          `${relations.projections.get(item) ?? this.expr(item.expr)} AS ${quoteYqlIdentifier(item.alias)}`,
      )
      .join(', ');
    let sql = `SELECT ${ast.distinct ? 'DISTINCT ' : ''}${projection || '*'}`;
    if (ast.from) sql += ` FROM ${this.source(ast.from)}`;
    for (const join of ast.joins ?? []) {
      if (join.lateral)
        return unsupported('LATERAL joins; use an explicit native YQL JOIN');
      sql += ` ${join.joinType.toUpperCase()} JOIN ${this.source(join.source)} ON ${join.on.kind === 'eq-col-join-on' ? `${this.expr(join.on.left)} = ${this.expr(join.on.right)}` : this.expr(join.on)}`;
    }
    sql += relations.joins.join('');
    if (ast.where) sql += ` WHERE ${this.expr(ast.where)}`;
    if (ast.groupBy?.length)
      sql += ` GROUP BY ${ast.groupBy.map((expr) => this.expr(expr)).join(', ')}`;
    if (ast.having) sql += ` HAVING ${this.expr(ast.having)}`;
    if (ast.orderBy?.length) sql += ` ORDER BY ${this.order(ast.orderBy)}`;
    const limit = (value: number | AnyExpression) =>
      typeof value === 'number' ? String(value) : this.expr(value);
    if (ast.limit !== undefined) sql += ` LIMIT ${limit(ast.limit)}`;
    else if (ast.offset !== undefined) sql += ' LIMIT 18446744073709551615ul';
    if (ast.offset !== undefined) sql += ` OFFSET ${limit(ast.offset)}`;
    return sql;
  }
  returning(items: readonly ProjectionItem[] | undefined): string {
    if (!items?.length) return ' RETURNING *'; // exact affected count, never physical write statistics
    const columns: [string, string][] = items.map((item) => {
      if (item.expr.kind !== 'column-ref')
        return unsupported('computed mutation RETURNING projections');
      return [item.alias, item.expr.column];
    });
    this.resultColumns = columns;
    return ` RETURNING ${[...new Set(columns.map(([, column]) => quoteYqlIdentifier(column)))].join(', ')}`;
  }
  insert(ast: InsertAst, program?: ReferentialProgram): string {
    if (!ast.rows.length) return unsupported('an empty INSERT');
    if (ast.onConflict) return this.upsert(ast, program);
    const columns = [...new Set(ast.rows.flatMap((row) => Object.keys(row)))];
    if (!columns.length)
      return unsupported(
        'INSERT DEFAULT VALUES; provide at least one explicit value',
      );
    const rows = ast.rows
      .map(
        (row) =>
          `(${columns
            .map((column) => {
              const value = row[column];
              if (!value || value.kind === 'default-value')
                return unsupported(
                  'heterogeneous bulk insert rows with implicit defaults; group rows by supplied fields',
                );
              return this.expr(value);
            })
            .join(', ')})`,
      )
      .join(', ');
    if (program?.outgoing(ast.table).length) {
      const table = this.tableDefinition(ast.table);
      const fields = [
        ...new Set(
          program
            .outgoing(ast.table)
            .flatMap(({ fk }) => [...fk.source.columns]),
        ),
      ];
      program.checkParents(
        ast.table,
        ast.rows
          .map(
            (row) =>
              `SELECT ${fields
                .map((name) => {
                  const value = row[name];
                  const column = table.columns[name]!;
                  const expression =
                    value && value.kind !== 'default-value'
                      ? this.expr(value)
                      : column.default?.kind === 'literal'
                        ? literalDefault(
                            column.default.value,
                            column.codecId,
                            column.typeParams,
                            !!column.many,
                          )
                        : column.nullable
                          ? `CAST(NULL AS ${yqlTypeForCodec(column.codecId, column.typeParams)}?)`
                          : unsupported(
                              `INSERT missing foreign key field ${name}`,
                            );
                  return `${expression} AS ${quoteYqlIdentifier(name)}`;
                })
                .join(', ')}`,
          )
          .join(' UNION ALL '),
      );
    }
    return `INSERT INTO ${this.table(ast.table)} (${columns.map(quoteYqlIdentifier).join(', ')}) VALUES ${rows}${this.returning(ast.returning)}`;
  }
  upsert(ast: InsertAst, program?: ReferentialProgram): string {
    const conflict = ast.onConflict;
    if (!conflict) throw new TypeError('UPSERT requires a conflict clause');
    if (conflict.action.kind === 'do-nothing' && !conflict.columns.length)
      return unsupported(
        'ON CONFLICT SKIP; YDB has no native INSERT OR IGNORE',
      );
    if (ast.rows.length !== 1)
      return unsupported('bulk UPSERT with different create/update branches');
    const table = this.tableDefinition(ast.table);
    const key = table.primaryKey?.columns ?? [];
    const targets = conflict.columns.map((column) => column.column);
    if (
      key.length !== targets.length ||
      key.some((column) => !targets.includes(column))
    )
      return unsupported('UPSERT on a non-primary unique index');
    const row = ast.rows[0];
    if (!row) throw new TypeError('UPSERT requires one row');
    const updateSet =
      conflict.action.kind === 'do-update-set'
        ? conflict.action.set
        : undefined;
    if (updateSet && key.some((column) => column in updateSet))
      return unsupported('UPSERT that changes the primary key');
    const where = key
      .map((column) => {
        const value = row[column];
        if (!value || value.kind === 'default-value')
          return unsupported('UPSERT without explicit primary key');
        return `${quoteYqlIdentifier(column)} = ${this.expr(value)}`;
      })
      .join(' AND ');
    if (conflict.action.kind === 'do-nothing') {
      const columns = Object.keys(row);
      const values = columns.map((column) => {
        const value = row[column];
        if (!value || value.kind === 'default-value')
          return unsupported('UPSERT with explicit DEFAULT values');
        return `${this.expr(value)} AS ${quoteYqlIdentifier(column)}`;
      });
      const candidates = `SELECT ${values.join(', ')} FROM AS_TABLE([<|__prisma_ydb_dummy: 0|>]) WHERE NOT EXISTS(SELECT * FROM ${this.table(ast.table)} WHERE ${where})`;
      if (
        program?.outgoing(ast.table).length &&
        program
          .outgoing(ast.table)
          .some(({ fk }) =>
            fk.source.columns.some((column) => !(column in row)),
          )
      )
        return unsupported('UPSERT SKIP with implicit foreign key defaults');
      program?.checkParents(ast.table, candidates);
      return `INSERT INTO ${this.table(ast.table)} (${columns.map(quoteYqlIdentifier).join(', ')}) ${candidates}${this.returning(ast.returning)}`;
    }
    const existing = '$__prisma_ydb_existing';
    const columns = Object.keys(table.columns);
    const select = columns.map((column) => {
      const definition = table.columns[column];
      if (!definition) throw new TypeError(`Unknown YDB column: ${column}`);
      const supplied = row[column];
      const create =
        supplied && supplied.kind !== 'default-value'
          ? this.expr(supplied)
          : definition.default?.kind === 'literal'
            ? literalDefault(
                definition.default.value,
                definition.codecId,
                definition.typeParams,
                !!definition.many,
              )
            : definition.nullable
              ? `CAST(NULL AS ${definition.many ? 'Json' : yqlTypeForCodec(definition.codecId, definition.typeParams)}?)`
              : unsupported(`UPSERT missing required create field ${column}`);
      const updated =
        conflict.action.kind === 'do-update-set'
          ? conflict.action.set[column]
          : undefined;
      const update = updated
        ? this.expr(updated)
        : `(SELECT ${quoteYqlIdentifier(column)} FROM ${existing})`;
      const expression = `IF(EXISTS(SELECT * FROM ${existing}), ${update}, ${create})`;
      return `${definition.nullable ? expression : `Unwrap(${expression})`} AS ${quoteYqlIdentifier(column)}`;
    });
    const capture = `${existing} = SELECT * FROM ${this.table(ast.table)} WHERE ${where};`;
    if (!program)
      return `${capture}\nUPSERT INTO ${this.table(ast.table)} (${columns.map(quoteYqlIdentifier).join(', ')}) SELECT ${select.join(', ')}${this.returning(ast.returning)}`;
    program.statements.push(capture);
    program.update(
      ast.table,
      `SELECT * FROM ${existing}`,
      Object.keys(updateSet ?? {}),
    );
    program.checkParents(ast.table, `SELECT ${select.join(', ')}`);
    return `UPSERT INTO ${this.table(ast.table)} (${columns.map(quoteYqlIdentifier).join(', ')}) SELECT ${select.join(', ')}${this.returning(ast.returning)}`;
  }
  render(ast: AnyQueryAst): string {
    if (ast.kind === 'select') return this.select(ast);
    if (ast.kind === 'raw-query')
      return ast.parts
        .map((part) => (typeof part === 'string' ? part : this.expr(part)))
        .join('');
    this.mutationTable = ast.table.alias ?? ast.table.name;
    const program = ReferentialProgram.applies(this.contract, ast.table)
      ? new ReferentialProgram(
          this.contract,
          (source) => this.table(source),
          quoteYqlIdentifier,
        )
      : undefined;
    if (ast.kind === 'insert') {
      const statement = this.insert(ast, program);
      return program?.render(statement) ?? statement;
    }
    const where = ast.where ? ` WHERE ${this.expr(ast.where)}` : '';
    const original = program
      ? `SELECT * FROM ${this.table(ast.table)}${where}`
      : '';
    if (ast.kind === 'update') {
      if (!Object.keys(ast.set).length) return unsupported('an empty UPDATE');
      program?.update(ast.table, original, Object.keys(ast.set));
      if (
        program
          ?.outgoing(ast.table)
          .some(({ fk }) =>
            fk.source.columns.some((column) => column in ast.set),
          )
      ) {
        const fields = [
          ...new Set(
            program
              .outgoing(ast.table)
              .flatMap(({ fk }) => [...fk.source.columns]),
          ),
        ];
        program.checkParents(
          ast.table,
          `SELECT ${fields.map((column) => `${ast.set[column] ? this.expr(ast.set[column]) : quoteYqlIdentifier(column)} AS ${quoteYqlIdentifier(column)}`).join(', ')} FROM ${this.table(ast.table)}${where}`,
        );
      }
      const statement = `UPDATE ${this.table(ast.table)} SET ${Object.entries(
        ast.set,
      )
        .map(
          ([column, value]) =>
            `${quoteYqlIdentifier(column)} = ${this.expr(value)}`,
        )
        .join(', ')}${where}${this.returning(ast.returning)}`;
      return program?.render(statement) ?? statement;
    }
    program?.delete(ast.table, original);
    const statement = `DELETE FROM ${this.table(ast.table)}${where}${this.returning(ast.returning)}`;
    return program?.render(statement) ?? statement;
  }
}

export function compileYql(
  ast: AnyQueryAst,
  contract: Contract<SqlStorage>,
): LoweredStatement {
  const compiler = new YqlCompiler(contract, ast);
  const body = compiler.render(ast);
  const listParams = new Set<AnyParamRef>();
  if (ast.kind === 'insert' || ast.kind === 'update') {
    const table = compiler.tableDefinition(ast.table);
    const collect = (values: Readonly<Record<string, unknown>>) => {
      for (const [name, value] of Object.entries(values)) {
        if (
          table?.columns[name]?.many &&
          value &&
          typeof value === 'object' &&
          'kind' in value &&
          (value.kind === 'param-ref' || value.kind === 'prepared-param-ref')
        )
          listParams.add(value as AnyParamRef);
      }
    };
    if (ast.kind === 'insert') {
      ast.rows.forEach(collect);
      if (ast.onConflict?.action.kind === 'do-update-set')
        collect(ast.onConflict.action.set);
    } else collect(ast.set);
  }
  const types = compiler.refs.map((ref) =>
    inferYqlParameterType(ref, listParams.has(ref)),
  );
  const headers = [
    `-- prisma-ydb-param-types: ${JSON.stringify(types)}`,
    ...(ast.kind === 'insert' || ast.kind === 'update' || ast.kind === 'delete'
      ? ['-- prisma-ydb-affected-rows: returning']
      : ast.kind === 'select'
        ? ['-- prisma-ydb-affected-rows: none']
        : []),
    ...(compiler.resultColumns
      ? [
          `-- prisma-ydb-result-columns: ${JSON.stringify(compiler.resultColumns)}`,
        ]
      : []),
  ];
  return {
    sql: [
      ...headers,
      ...types.map((type, index) => `DECLARE $p${index + 1} AS ${type};`),
      body,
    ].join('\n'),
    params: compiler.refs.map((ref) =>
      ref.kind === 'prepared-param-ref'
        ? { kind: 'bind', name: ref.name }
        : { kind: 'literal', value: ref.value },
    ),
  };
}
