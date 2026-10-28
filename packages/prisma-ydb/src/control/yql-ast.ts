import { yqlCode, yqlResultStatements } from '../driver/yql-syntax.js';
export type SExpression = string | SExpression[];

/** Parse YDB's printed AST, including quote shorthand and escaped string atoms. */
export function parseSExpression(text: string): SExpression {
  let offset = 0;
  function read(): SExpression {
    while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
    const ch = text[offset++];
    if (ch === "'") return ['quote', read()];
    if (ch === '(') {
      const nodes: SExpression[] = [];
      for (;;) {
        while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++;
        if (text[offset] === ')') {
          offset++;
          return nodes;
        }
        if (offset >= text.length) throw new TypeError('Unclosed YDB AST list');
        nodes.push(read());
      }
    }
    if (ch === '"') {
      let atom = '';
      while (offset < text.length) {
        const c = text[offset++];
        if (c === '"') return atom;
        if (c === '\\') {
          const escaped = text[offset++];
          if (escaped === undefined) break;
          if (escaped === 'x') {
            const hex = text.slice(offset, offset + 2);
            if (!/^[0-9a-f]{2}$/i.test(hex))
              throw new TypeError('Invalid YDB AST escape');
            atom += String.fromCharCode(parseInt(hex, 16));
            offset += 2;
          } else
            atom +=
              ({ n: '\n', r: '\r', t: '\t' } as Record<string, string>)[
                escaped
              ] ?? escaped;
        } else atom += c;
      }
      throw new TypeError('Unclosed YDB AST string');
    }
    if (ch === undefined || ch === ')')
      throw new TypeError('Unexpected YDB AST token');
    const start = offset - 1;
    while (offset < text.length && !/[\s()']/.test(text[offset])) offset++;
    return text.slice(start, offset);
  }
  const result = read();
  if (text.slice(offset).trim()) throw new TypeError('Trailing YDB AST tokens');
  return result;
}

export interface YqlColumnType {
  readonly name: string;
  readonly type: string;
}

/** Only the physical query's outward result bindings describe caller-visible sets. */
export function inferYqlResults(
  ast: string,
  plan: string,
  file: string,
  text?: string,
): YqlColumnType[][] {
  try {
    const root = parseSExpression(ast);
    if (!Array.isArray(root)) throw new Error('Missing program');
    // Top-level lets only: nested lambda/block lets have a different lexical scope.
    const aliases = new Map<string, SExpression>();
    for (const node of root)
      if (
        Array.isArray(node) &&
        node[0] === 'let' &&
        typeof node[1] === 'string' &&
        node.length === 3
      )
        aliases.set(node[1], node[2]);
    function resolve(node: SExpression, seen = new Set<string>()): SExpression {
      if (typeof node === 'string' && node.startsWith('$')) {
        if (seen.has(node) || !aliases.has(node))
          throw new Error(`Unresolved alias ${node}`);
        return resolve(aliases.get(node)!, new Set([...seen, node]));
      }
      if (Array.isArray(node) && node[0] === 'quote' && node.length === 2)
        return node[1];
      return node;
    }
    function list(node: SExpression | undefined): SExpression[] {
      if (node === undefined) throw new Error('Missing AST node');
      const value = resolve(node);
      if (!Array.isArray(value)) throw new Error('Expected AST list');
      return value;
    }
    function atom(node: SExpression): string {
      const value = resolve(node);
      if (typeof value !== 'string') throw new Error('Expected AST atom');
      return value;
    }
    function type(node: SExpression): string {
      const shape = list(node);
      switch (shape[0]) {
        case 'DataType': {
          const name = atom(shape[1]);
          if (name === 'Decimal' && shape.length === 4)
            return `Decimal(${atom(shape[2])},${atom(shape[3])})`;
          if (shape.length !== 2) throw new Error(`Unknown ${name} shape`);
          return name;
        }
        case 'OptionalType':
        case 'ListType':
          if (shape.length !== 2) throw new Error('Invalid container');
          return `${shape[0] === 'OptionalType' ? 'Optional' : 'List'}<${type(shape[1])}>`;
        case 'TupleType':
          return `Tuple<${shape.slice(1).map(type).join(',')}>`;
        case 'StructType':
          return `Struct<${members(shape)
            .map((m) => `\`${m.name.replaceAll('`', '``')}\`:${m.type}`)
            .join(',')}>`;
        default:
          throw new Error(`Unsupported YQL type ${String(shape[0])}`);
      }
    }
    function members(shape: SExpression[]): YqlColumnType[] {
      const result = shape.slice(1).map((member) => {
        const pair = list(member);
        if (pair.length !== 2) throw new Error('Invalid struct member');
        return { name: atom(pair[0]), type: type(pair[1]) };
      });
      if (new Set(result.map((m) => m.name)).size !== result.length)
        throw new Error('Duplicate column');
      return result;
    }
    const returns = root.filter(
      (node) => Array.isArray(node) && node[0] === 'return',
    );
    if (returns.length !== 1) throw new Error('Expected one physical query');
    const physical = list(list(returns[0])[1]);
    if (physical[0] !== 'KqpPhysicalQuery' || physical.length !== 4)
      throw new Error('Unknown physical query');
    const results = list(physical[2]).map((binding) => {
      const entry = list(binding);
      if (entry[0] !== 'KqpTxResultBinding' || entry.length !== 4)
        throw new Error('Unknown result binding');
      const rows = list(entry[1]);
      if (rows[0] !== 'ListType' || rows.length !== 2)
        throw new Error('Expected result list');
      const row = list(rows[1]);
      if (row[0] !== 'StructType') throw new Error('Expected result struct');
      return members(row);
    });
    if (plan) {
      const json = JSON.parse(plan) as { Plan?: unknown };
      let count = 0;
      function countSets(node: unknown): void {
        if (!node || typeof node !== 'object') return;
        if ((node as Record<string, unknown>).PlanNodeType === 'ResultSet')
          count++;
        for (const value of Object.values(node))
          if (typeof value === 'object') countSets(value);
      }
      if (json.Plan) {
        countSets(json.Plan);
        if (count !== results.length)
          throw new Error(
            `Plan result count ${count} differs from bindings ${results.length}`,
          );
      }
    }
    // EXPLAIN keeps a binding for DISCARD statements, but the client never
    // receives that result set; drop them by source statement order.
    if (text !== undefined && /\bDISCARD\b/i.test(yqlCode(text))) {
      const statements = yqlResultStatements(text);
      if (!statements || statements.length !== results.length)
        throw new Error(
          `cannot map DISCARD statements to ${results.length} result bindings`,
        );
      return results.filter((_columns, index) => !statements[index]!.discarded);
    }
    return results;
  } catch (error) {
    throw new Error(
      `${file}: cannot infer result types from YDB plan: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
