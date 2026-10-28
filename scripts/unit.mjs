import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline compiler tests: they emit contracts with the Prisma CLI but never connect.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(root, 'packages/prisma-ydb/test/unit');
const files = (await readdir(directory))
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => resolve(directory, name));
if (!files.length) throw new Error('No unit test files found');
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
