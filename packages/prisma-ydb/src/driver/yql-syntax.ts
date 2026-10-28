/** Remove comments and literals while retaining offsets and backtick type names. */
export function yqlCode(text: string): string {
  return text.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"/g,
    (match) => match.replace(/[^\n]/g, ' '),
  );
}

/** Split a nested YQL type at top-level commas (or a struct member colon). */
export function splitYqlType(text: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0,
    start = 0,
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '`') {
      if (quoted && text[i + 1] === '`') {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (ch === '<' || ch === '(') depth++;
    if (ch === '>' || ch === ')') depth--;
    if (depth < 0) throw new TypeError(`Invalid YQL type: ${text}`);
    if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quoted || depth !== 0) throw new TypeError(`Invalid YQL type: ${text}`);
  if (text.trim()) parts.push(text.slice(start).trim());
  return parts;
}

export function assertUsedYqlParams(
  text: string,
  names: readonly string[],
): void {
  const code = yqlCode(text).replace(/`(?:``|[^`])*`/g, ' ');
  const used = new Set(
    [...code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)\b/g)].map((m) => m[1]),
  );
  for (const name of names)
    if (!used.has(name)) throw new TypeError(`Unused YQL parameter: $${name}`);
}

/**
 * Top-level statements that produce a result binding, in order, and whether
 * each is `DISCARD`ed. YDB's EXPLAIN keeps a binding for discarded results, so
 * the generator needs the source to drop them. Returns undefined for scripts
 * whose blocks (actions, subqueries, EVALUATE/DO) this scan cannot attribute.
 */
export function yqlResultStatements(
  text: string,
): { readonly discarded: boolean }[] | undefined {
  const code = yqlCode(text).replace(/`(?:``|[^`])*`/g, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
  if (/\b(?:DEFINE|EVALUATE|BEGIN)\b|\bDO\s/i.test(code)) return undefined;
  const statements: string[] = [];
  let depth = 0,
    start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) {
      statements.push(code.slice(start, i));
      start = i + 1;
    }
  }
  statements.push(code.slice(start));
  const results: { discarded: boolean }[] = [];
  for (const raw of statements) {
    const statement = raw.trim();
    if (!statement) continue;
    const discarded = /^DISCARD\b/i.test(statement);
    const body = discarded ? statement.replace(/^DISCARD\s+/i, '') : statement;
    if (
      /^(?:SELECT|PROCESS|REDUCE|VALUES|\()/i.test(body) ||
      (/^(?:INSERT|UPSERT|REPLACE|UPDATE|DELETE)\b/i.test(body) &&
        /\bRETURNING\b/i.test(body))
    )
      results.push({ discarded });
  }
  return results;
}
