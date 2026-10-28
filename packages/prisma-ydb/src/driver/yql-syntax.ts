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
