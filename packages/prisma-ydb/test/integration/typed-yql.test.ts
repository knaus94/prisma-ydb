import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { generateYql } from 'prisma-ydb/control';
import { createFixture, quote, repositoryRoot } from './helpers.ts';

const exec = promisify(execFile);
const cli = join(repositoryRoot, 'packages/prisma-ydb/dist/cli.js');

test('Typed YQL generates, typechecks, executes on db/tx and reports generation errors', async (context) => {
  const fixture = await createFixture(context, {
    schema: (table) =>
      `// use prisma-8\nmodel Item {\n id String @id\n @@map("${table('Item')}")\n}`,
  });
  const table = quote(fixture.table('Item'));
  await fixture.ddl(
    `CREATE TABLE ${table} (id Utf8 NOT NULL, amount Decimal(12,2), at Timestamp, PRIMARY KEY(id));`,
  );
  const dir = join(fixture.cwd, 'prisma/yql');
  await mkdir(dir, { recursive: true });
  const sources = {
    'save-item.yql': `DECLARE $id AS Utf8; DECLARE $amount AS Decimal(12,2)?; DECLARE $at AS Timestamp; UPSERT INTO ${table} (id, amount, at) VALUES ($id, $amount, $at);`,
    'item-history.yql': `DECLARE $ids AS List<Utf8>; SELECT id, amount, at FROM ${table} WHERE id IN $ids ORDER BY id; SELECT COUNT(*) AS total, MAX(at) AS last FROM ${table};`,
  };
  for (const [file, text] of Object.entries(sources))
    await writeFile(join(dir, file), text);
  const result = await generateYql({ config: fixture.configPath });
  const generated = await readFile(result.output, 'utf8');
  assert.match(generated, /amount\?: string \| null \| undefined/);
  assert.match(generated, /at: bigint \| null/);
  await writeFile(
    join(fixture.cwd, 'tsconfig.yql.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        skipLibCheck: true,
        types: ['node'],
        rootDir: 'generated',
        outDir: 'compiled',
      },
      files: ['generated/yql.ts'],
    }),
  );
  // Parent test already owns the heavy-command lock; run this single child serially at inherited nice priority.
  await exec(process.execPath, [
    join(repositoryRoot, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(fixture.cwd, 'tsconfig.yql.json'),
  ]);
  const { saveItem, itemHistory } = await import(
    pathToFileURL(join(fixture.cwd, 'compiled/yql.js')).href
  );
  // EXPLAIN must not execute the mutation.
  const empty = await itemHistory(fixture.db, { ids: [] });
  assert.equal(empty[1][0].total, 0n);
  const at = 1_767_323_045_123_456n;
  assert.equal(
    await saveItem(fixture.db, { id: 'one', at, amount: '12.50' }),
    undefined,
  );
  await fixture.db.transaction(async (tx) => {
    await saveItem(tx, { id: 'two', at: at + 1n });
    const [rows, summary] = await itemHistory(tx, { ids: ['one', 'two'] });
    assert.deepEqual(rows, [
      { amount: '12.50', at, id: 'one' },
      { amount: null, at: at + 1n, id: 'two' },
    ]);
    assert.deepEqual(summary, [{ last: at + 1n, total: 2n }]);
  });
  await generateYql({ config: fixture.configPath, check: true });
  await exec(process.execPath, [
    cli,
    'yql',
    'generate',
    '--config',
    fixture.configPath,
    '--check',
  ]);
  await writeFile(result.output, generated + '// stale\n');
  await assert.rejects(
    generateYql({ config: fixture.configPath, check: true }),
    /generated YQL is stale/,
  );
  await assert.rejects(
    exec(process.execPath, [
      cli,
      'yql',
      'generate',
      '--config',
      fixture.configPath,
      '--check',
    ]),
    /generated YQL is stale/,
  );
  const errors = {
    'unknown.yql': {
      text: `SELECT unknown_column FROM ${table};`,
      pattern: /unknown.yql: YDB EXPLAIN failed:.*unknown_column/s,
    },
    'unused.yql': {
      text: 'DECLARE $id AS Utf8; SELECT 1;',
      pattern: /unused.yql: Unused YQL parameter: \$id/,
    },
    'typo.yql': {
      text: 'DECLARE $id AS Utf8; SELECT $idd;',
      pattern: /typo.yql: Unused YQL parameter/,
    },
    'undeclared.yql': {
      text: 'SELECT $idd;',
      pattern: /undeclared.yql: YDB EXPLAIN failed:.*idd/s,
    },
    'unsupported.yql': {
      text: 'SELECT CurrentUtcDatetime() AS at;',
      pattern: /unsupported.yql: Unsupported YQL type: DATETIME/,
    },
  };
  for (const [file, { text, pattern }] of Object.entries(errors)) {
    await writeFile(join(dir, file), text);
    await assert.rejects(generateYql({ config: fixture.configPath }), pattern);
    await rm(join(dir, file));
  }
});
