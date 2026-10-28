import type { Contract } from '@prisma/orm-framework/contract/types';
import type {
  ForeignKey,
  SqlStorage,
  StorageTable,
} from '@prisma/orm-family-sql/contract/types';
import { TableSource } from '@prisma/orm-family-sql/relational-core/ast';
import { runtimeError } from '@prisma/orm-framework/components/runtime';
import { yqlTypeForCodec } from './codecs.js';
import { lookupIndex } from './keys.js';

interface Relation {
  namespace: string;
  table: StorageTable;
  source: TableSource;
  fk: ForeignKey;
  sourceIndex: string | undefined;
  targetIndex: string | undefined;
}

interface ActionGraph {
  incoming: Map<string, Relation[]>;
  outgoing: Map<string, Relation[]>;
  defaultNamespace: string | undefined;
}

const actionGraphs = new WeakMap<Contract<SqlStorage>, ActionGraph>();
const noRelations: readonly Relation[] = [];
function tableKey(namespace: string, name: string): string {
  return `${namespace}\0${name}`;
}
function actionGraph(contract: Contract<SqlStorage>): ActionGraph {
  const cached = actionGraphs.get(contract);
  if (cached) return cached;
  const namespaces = Object.entries(contract.storage.namespaces);
  const graph: ActionGraph = {
    incoming: new Map(),
    outgoing: new Map(),
    defaultNamespace: namespaces.length === 1 ? namespaces[0]?.[0] : undefined,
  };
  for (const [namespace, definition] of namespaces) {
    for (const [name, table] of Object.entries(
      definition.entries.table ?? {},
    )) {
      for (const fk of table.foreignKeys) {
        if (!fk.onDelete && !fk.onUpdate) continue;
        const relation = {
          namespace,
          table,
          source: TableSource.named(name, undefined, namespace),
          fk,
          sourceIndex: lookupIndex(table, fk.source.columns),
          targetIndex: lookupIndex(
            contract.storage.namespaces[fk.target.namespaceId || namespace]
              ?.entries.table?.[fk.target.tableName],
            fk.target.columns,
          ),
        };
        for (const [map, key] of [
          [graph.outgoing, tableKey(namespace, name)],
          [
            graph.incoming,
            tableKey(fk.target.namespaceId || namespace, fk.target.tableName),
          ],
        ] as const) {
          const relations = map.get(key);
          if (relations) relations.push(relation);
          else map.set(key, [relation]);
        }
      }
    }
  }
  actionGraphs.set(contract, graph);
  return graph;
}

/** DISCARD evaluates guards without adding result sets before RETURNING. */
export class ReferentialProgram {
  static applies(contract: Contract<SqlStorage>, source: TableSource): boolean {
    const graph = actionGraph(contract);
    const key = tableKey(
      source.namespaceId ?? graph.defaultNamespace ?? '',
      source.name,
    );
    return graph.incoming.has(key) || graph.outgoing.has(key);
  }
  readonly statements: string[] = [];
  private counter = 0;
  private readonly graph: ActionGraph;
  constructor(
    contract: Contract<SqlStorage>,
    private readonly tableSql: (source: TableSource) => string,
    private readonly quote: (identifier: string) => string,
  ) {
    this.graph = actionGraph(contract);
  }
  private key(source: TableSource): string {
    return tableKey(
      source.namespaceId ?? this.graph.defaultNamespace ?? '',
      source.name,
    );
  }
  private incoming(source: TableSource): readonly Relation[] {
    return this.graph.incoming.get(this.key(source)) ?? noRelations;
  }
  outgoing(source: TableSource): readonly Relation[] {
    return this.graph.outgoing.get(this.key(source)) ?? noRelations;
  }
  capture(select: string): string {
    const name = `$__prisma_ydb_referential_${++this.counter}`;
    this.statements.push(`${name} = ${select};`);
    return name;
  }
  private guard(violation: string): void {
    this.statements.push(
      `DISCARD SELECT Ensure(TRUE, NOT EXISTS(${violation}), "YDB.REFERENTIAL_ACTION");`,
    );
  }
  private join(fk: ForeignKey, child = 'c', parent = 'p'): string {
    return fk.source.columns
      .map(
        (column, index) =>
          `${child}.${this.quote(column)} = ${parent}.${this.quote(fk.target.columns[index]!)}`,
      )
      .join(' AND ');
  }
  private children(relation: Relation, parents: string): string {
    const view = relation.sourceIndex
      ? ` VIEW ${this.quote(relation.sourceIndex)}`
      : '';
    return `SELECT c.* FROM ${parents} AS p INNER JOIN ${this.tableSql(relation.source)}${view} AS c ON ${this.join(relation.fk)}`;
  }
  delete(
    source: TableSource,
    select: string,
    ancestry: readonly string[] = [],
  ): void {
    const incoming = this.incoming(source);
    if (!incoming.length) return;
    const identity = `${source.namespaceId ?? ''}/${source.name}`;
    if (ancestry.includes(identity))
      throw runtimeError(
        'YDB.UNSUPPORTED_FEATURE',
        'Cyclic cascading deletes cannot be compiled',
      );
    const parents = this.capture(select);
    for (const relation of incoming) {
      let children = this.children(relation, parents);
      if (this.key(relation.source) === this.key(source)) {
        const keys = relation.table.primaryKey?.columns;
        if (!keys?.length)
          throw new TypeError('Self-relations require a primary key');
        const on = keys
          .map((column) => `c.${this.quote(column)} = d.${this.quote(column)}`)
          .join(' AND ');
        children = `SELECT c.* FROM (${children}) AS c LEFT ONLY JOIN ${parents} AS d ON ${on}`;
      }
      switch (relation.fk.onDelete ?? 'noAction') {
        case 'restrict':
        case 'noAction':
          this.guard(children);
          break;
        case 'cascade': {
          const rows = this.capture(children);
          this.delete(relation.source, `SELECT * FROM ${rows}`, [
            ...ancestry,
            identity,
          ]);
          const keys = relation.table.primaryKey?.columns;
          if (!keys?.length)
            throw new TypeError(
              'Cascading deletes require a child primary key',
            );
          this.statements.push(
            `DELETE FROM ${this.tableSql(relation.source)} ON SELECT ${keys.map(this.quote).join(', ')} FROM ${rows};`,
          );
          break;
        }
        case 'setNull': {
          const rows = this.capture(children);
          this.update(
            relation.source,
            `SELECT * FROM ${rows}`,
            relation.fk.source.columns,
          );
          const keys = relation.table.primaryKey?.columns;
          if (!keys?.length)
            throw new TypeError('SetNull requires a child primary key');
          const fields = relation.fk.source.columns.map((name) => {
            const column = relation.table.columns[name];
            if (!column?.nullable)
              throw new TypeError(
                'SetNull requires nullable foreign key columns',
              );
            return `CAST(NULL AS ${yqlTypeForCodec(column.codecId, column.typeParams)}?) AS ${this.quote(name)}`;
          });
          this.statements.push(
            `UPDATE ${this.tableSql(relation.source)} ON SELECT ${[...keys.map(this.quote), ...fields].join(', ')} FROM ${rows};`,
          );
          break;
        }
        default:
          throw runtimeError(
            'YDB.UNSUPPORTED_FEATURE',
            'Unsupported referential delete action',
          );
      }
    }
  }
  update(
    source: TableSource,
    select: string,
    assigned: readonly string[],
  ): void {
    const incoming = this.incoming(source).filter(({ fk }) =>
      fk.target.columns.some((column) => assigned.includes(column)),
    );
    if (!incoming.length) return;
    const parents = this.capture(select);
    for (const relation of incoming)
      this.guard(this.children(relation, parents));
  }
  checkParents(source: TableSource, select: string): void {
    const outgoing = this.outgoing(source);
    if (!outgoing.length) return;
    const rows = this.capture(select);
    for (const { namespace, fk, targetIndex } of outgoing) {
      const parent = TableSource.named(
        fk.target.tableName,
        undefined,
        fk.target.namespaceId || namespace,
      );
      const present = fk.source.columns
        .map((column) => `c.${this.quote(column)} IS NOT NULL`)
        .join(' AND ');
      const view = targetIndex ? ` VIEW ${this.quote(targetIndex)}` : '';
      // A LEFT ONLY JOIN avoids correlated subqueries and compares every key component.
      this.guard(
        `SELECT c.* FROM ${rows} AS c LEFT ONLY JOIN ${this.tableSql(parent)}${view} AS p ON ${this.join(fk)} WHERE ${present}`,
      );
    }
  }
  render(statement: string): string {
    return this.statements.length
      ? `${this.statements.join('\n')}\n${statement}`
      : statement;
  }
}
