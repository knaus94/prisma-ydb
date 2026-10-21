import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(
  await readFile(
    new URL('../packages/prisma-ydb/package.json', import.meta.url),
    'utf8',
  ),
);
const mode = process.argv[2];
if (!['pack', 'dry-run', 'publish'].includes(mode))
  throw new Error('Use pack, dry-run or publish');
const artifacts = path.join(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const tag = manifest.version.includes('-') ? 'next' : 'latest';
const args =
  mode === 'pack'
    ? ['pack', './packages/prisma-ydb', '--pack-destination', artifacts]
    : [
        'publish',
        './packages/prisma-ydb',
        '--access',
        'public',
        '--tag',
        tag,
        ...(mode === 'dry-run' ? ['--dry-run'] : []),
        ...(process.env.GITHUB_ACTIONS === 'true' && mode === 'publish'
          ? ['--provenance']
          : []),
      ];
const result = spawnSync('npm', args, {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
