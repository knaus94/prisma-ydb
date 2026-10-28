import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env['YDB_CONNECTION_STRING']?.trim()) {
  console.error(
    'YDB_CONNECTION_STRING is required; select a disposable local YDB database for integration tests.',
  );
  process.exitCode = 1;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = resolve(root, 'packages/prisma-ydb/test/integration');
  const files = (await readdir(directory))
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => resolve(directory, name));
  if (!files.length) throw new Error('No driver integration test files found');
  const child = spawn(
    process.execPath,
    ['--test', '--test-concurrency=1', ...files],
    { cwd: root, stdio: 'inherit', env: process.env },
  );
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
