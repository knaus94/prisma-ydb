import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const version = process.argv[2];
// Require an explicit version so the resulting change is reviewable before publication.
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Usage: yarn release:version 0.1.0-rc.1');
}
for (const [command, args] of [
  [
    'npm',
    [
      'version',
      version,
      '--no-git-tag-version',
      '--no-workspaces-update',
      '--workspace',
      'prisma-ydb',
    ],
  ],
  [
    process.execPath,
    [
      fileURLToPath(
        new URL('../.yarn/releases/yarn-4.18.1.cjs', import.meta.url),
      ),
      'install',
    ],
  ],
]) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
  'Version updated. Review the package manifest, lockfile and changelog before publishing.',
);
