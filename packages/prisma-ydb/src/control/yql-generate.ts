import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import {
  loadConfig,
  requireConfigSections,
} from '@prisma/orm-toolchain/config-loader';
import { YDBError } from '@ydbjs/error';
import { yqlCode, assertUsedYqlParams } from '../driver/yql-syntax.js';
import { compileYqlType } from '../runtime/yql-types.js';
import type { YqlTypedMember } from '../runtime/define-yql.js';
import { inferYqlResults } from './yql-ast.js';
import { requireYdbControlDriver } from './driver.js';

export interface GenerateYqlOptions {
  readonly config?: string;
  readonly dir?: string;
  readonly output?: string;
  readonly check?: boolean;
}
export interface YqlSource {
  readonly file: string;
  readonly name: string;
  readonly text: string;
  readonly params: readonly YqlTypedMember[];
  readonly results: readonly (readonly YqlTypedMember[])[];
}
const reserved = new Set(
  'await break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield implements interface let package private protected public static arguments eval constructor __proto__ prototype'.split(
    ' ',
  ),
);
export function yqlFunctionName(file: string): string {
  const base = basename(file, '.yql');
  const converted = base.replace(
    /[-_\s]+(.)?/g,
    (_, letter: string | undefined) => letter?.toUpperCase() ?? '',
  );
  const name = converted.length
    ? converted[0].toLowerCase() + converted.slice(1)
    : '';
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) || reserved.has(name))
    throw new TypeError(`${file}: invalid or reserved function name ${name}`);
  return name;
}
export function parseYqlParams(text: string, file: string): YqlTypedMember[] {
  const code = yqlCode(text);
  const params: YqlTypedMember[] = [];
  const declarations =
    /\bDECLARE\s+\$([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+([^;]+);/gi;
  const remaining = code.replace(
    declarations,
    (_, name: string, type: string) => {
      if (params.some((p) => p.name === name))
        throw new TypeError(`${file}: duplicate parameter $${name}`);
      params.push({ name, type: type.trim() });
      return ' ';
    },
  );
  if (/\bDECLARE\b/i.test(remaining))
    throw new TypeError(
      `${file}: invalid DECLARE; use DECLARE $name AS <type>;`,
    );
  try {
    assertUsedYqlParams(
      remaining,
      params.map((p) => p.name),
    );
    for (const param of params) compileYqlType(param.type);
  } catch (error) {
    throw new Error(
      `${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return params;
}
function key(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}
function typeName(name: string): string {
  return name[0].toUpperCase() + name.slice(1);
}

/** Pure, deterministic emission; types and runtime metadata come from the same plan. */
export function renderYql(sources: readonly YqlSource[]): string {
  const sections = sources.map((source) => {
    try {
      const title = typeName(source.name);
      const params = `export type ${title}Params = {\n${source.params.map((p) => `  ${key(p.name)}${compileYqlType(p.type).type.type.case === 'optionalType' ? '?' : ''}: ${compileYqlType(p.type).input};`).join('\n')}\n};`;
      const rows = source.results.map(
        (columns, index) =>
          `export type ${title}Row${source.results.length === 1 ? '' : index + 1} = {\n${columns.map((c) => `  ${key(c.name)}: ${compileYqlType(c.type).output};`).join('\n')}\n};`,
      );
      // Validate result member names at generation time too.
      for (const columns of source.results)
        compileYqlType(
          `Struct<${columns.map((c) => `\`${c.name.replaceAll('`', '``')}\`:${c.type}`).join(',')}>`,
        );
      const result =
        source.results.length === 0
          ? 'void'
          : source.results.length === 1
            ? `${title}Row[]`
            : `[${source.results.map((_, i) => `${title}Row${i + 1}[]`).join(', ')}]`;
      return [
        params,
        ...rows,
        `export type ${title}Result = ${result};`,
        `export const ${source.name} = defineYql<${title}Params, ${title}Result>(${JSON.stringify({ name: source.name, text: source.text, params: source.params, results: source.results }, null, 2)});`,
      ].join('\n\n');
    } catch (error) {
      throw new Error(
        `${source.file}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  });
  const symbols = new Set(['defineYql', 'JsonValue', 'TimestampMicrosValue']);
  for (const source of sources) {
    const title = typeName(source.name);
    for (const symbol of [
      source.name,
      `${title}Params`,
      `${title}Result`,
      ...source.results.map(
        (_, i) => `${title}Row${source.results.length === 1 ? '' : i + 1}`,
      ),
    ]) {
      if (symbols.has(symbol))
        throw new Error(`${source.file}: generated name collision: ${symbol}`);
      symbols.add(symbol);
    }
  }
  const body = sections.join('\n\n');
  const imports = ["import { defineYql } from 'prisma-ydb/runtime';"];
  const typeText = sources
    .flatMap((source) => [
      ...source.params.map((p) => compileYqlType(p.type).input),
      ...source.results.flatMap((columns) =>
        columns.map((c) => compileYqlType(c.type).output),
      ),
    ])
    .join(' ')
    .replace(/"(?:\\.|[^"\\])*"/g, '');
  const types = ['JsonValue', 'TimestampMicrosValue'].filter((name) =>
    new RegExp(`\\b${name}\\b`).test(typeText),
  );
  if (types.length)
    imports.push(
      `import type { ${types.join(', ')} } from 'prisma-ydb/runtime';`,
    );
  return `// Generated by prisma-ydb yql generate. Do not edit.\n${imports.join('\n')}\n\n${body}\n`;
}

export async function generateYql(
  options: GenerateYqlOptions = {},
): Promise<{ output: string; files: number; text: string }> {
  const loaded = await loadConfig(options.config);
  if (!loaded.ok) throw loaded.failure;
  const checked = requireConfigSections(loaded.value, [
    'driver',
    'db',
    'contract',
  ]);
  if (!checked.ok) throw checked.failure;
  const config = checked.value;
  if (
    config.target.targetId !== 'ydb' ||
    !config.driver ||
    !config.db?.connection
  )
    throw new Error('YQL generation requires a YDB config with db.connection');
  const section = (
    config as typeof config & { yql?: { dir?: string; output?: string } }
  ).yql;
  const base = config.baseDir ?? process.cwd();
  const dir = resolve(base, options.dir ?? section?.dir ?? 'prisma/yql');
  // Prisma contract.output is the contract.json file; generated YQL lives beside it.
  const output = resolve(
    base,
    options.output ??
      section?.output ??
      resolve(
        dirname(
          config.contract?.output ??
            resolve(base, 'prisma/ydb/generated/contract.json'),
        ),
        'yql.ts',
      ),
  );
  const files = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.yql'))
    .map((e) => e.name)
    .sort();
  if (!files.length) throw new Error(`No .yql files found in ${dir}`);
  const names = new Set<string>(),
    titles = new Set<string>();
  const sources: YqlSource[] = [];
  // Parse all inputs before opening a database session or touching the output.
  for (const file of files) {
    const name = yqlFunctionName(file),
      title = typeName(name);
    if (names.has(name) || titles.has(title))
      throw new Error(`${file}: generated name collision: ${name}`);
    names.add(name);
    titles.add(title);
    const text = await readFile(resolve(dir, file), 'utf8');
    sources.push({
      file,
      name,
      text,
      params: parseYqlParams(text, file),
      results: [],
    });
  }
  const driver = requireYdbControlDriver(
    await config.driver.create(config.db.connection),
  );
  try {
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      try {
        const { ast, plan } = await driver.explainYql(source.text);
        sources[index] = {
          ...source,
          results: inferYqlResults(ast, plan, source.file, source.text),
        };
      } catch (error) {
        const issues =
          error instanceof YDBError
            ? JSON.stringify(error.issues)
            : error instanceof Error
              ? error.message
              : String(error);
        throw new Error(`${source.file}: YDB EXPLAIN failed: ${issues}`, {
          cause: error,
        });
      }
    }
  } finally {
    await driver.close();
  }
  const text = renderYql(sources);
  if (options.check) {
    let existing: string | undefined;
    try {
      existing = await readFile(output, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (existing !== text)
      throw new Error(
        `${output}: generated YQL is stale; run prisma-ydb yql generate`,
      );
  } else {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, text);
  }
  return { output, files: files.length, text };
}
