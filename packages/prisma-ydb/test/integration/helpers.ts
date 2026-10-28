import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { TestContext } from 'node:test';
import { ydb } from 'prisma-ydb/runtime';
import { YdbDriver } from 'prisma-ydb/driver';
import { listYdbTables, ydbContractSerializer } from 'prisma-ydb/control';
import { ydbBindingFromEnv } from 'prisma-ydb/environment';

export const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const require = createRequire(import.meta.url);
const prismaManifestPath = require.resolve('prisma/package.json');
const prismaManifest = JSON.parse(
  await readFile(prismaManifestPath, 'utf8'),
) as { bin: { prisma: string } };
const prismaCli = resolve(
  dirname(prismaManifestPath),
  prismaManifest.bin.prisma,
);
const controlTables = [
  '_prisma_ydb_lock',
  '_prisma_ydb_migrations',
  '_prisma_ledger',
  '_prisma_marker',
];

export function requireEndpoint(): string {
  const endpoint = process.env['YDB_CONNECTION_STRING']?.trim();
  if (!endpoint)
    throw new Error(
      'YDB_CONNECTION_STRING is required; select a disposable local YDB database for integration tests.',
    );
  return endpoint;
}

export function uniqueName(prefix: string): string {
  return `it_${prefix.replaceAll(/[^A-Za-z0-9_]/g, '_')}_${randomUUID().replaceAll('-', '')}`;
}

export function quote(name: string): string {
  return '`' + name.replaceAll('`', '``') + '`';
}

export interface PrismaResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Captures failures as values so migration/drift checks can assert diagnostics. */
export async function runPrisma(
  args: readonly string[],
  cwd: string,
): Promise<PrismaResult> {
  requireEndpoint();
  return new Promise((resolveResult, reject) => {
    execFile(
      process.execPath,
      [prismaCli, ...args],
      {
        cwd,
        env: process.env,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') {
          reject(error);
          return;
        }
        resolveResult({ code: error?.code ?? 0, stdout, stderr });
      },
    );
  });
}

export async function createFixture(
  context: Pick<TestContext, 'after'>,
  options: { schema: (table: (name: string) => string) => string },
) {
  const endpoint = requireEndpoint();
  const binding = ydbBindingFromEnv(endpoint);
  const cwd = join(repositoryRoot, 'tmp', uniqueName('integration'));
  const schemaPath = join(cwd, 'contract.prisma');
  const configPath = join(cwd, 'prisma.config.mjs');
  const names = new Map<string, string>();
  const table = (name: string) => {
    let physical = names.get(name);
    if (!physical) {
      physical = uniqueName(name);
      names.set(name, physical);
    }
    return physical;
  };
  const native = new YdbDriver({
    maxSessions: 2,
    minSessions: 0,
    queryTimeoutMs: 10_000,
    closeTimeoutMs: 5_000,
  });
  let connected = false,
    closed = false,
    ownsControl = false;
  let db: ReturnType<typeof ydb> | undefined;
  async function close() {
    if (closed) return;
    closed = true;
    const failures: unknown[] = [];
    try {
      await db?.close();
    } catch (error) {
      failures.push(error);
    }
    if (connected) {
      for (const name of [...names.values()].reverse()) {
        try {
          if (await native.tableExists(name))
            await native.executeYql({
              text: `DROP TABLE ${quote(name)};`,
              transactionMode: 'implicit',
              retry: false,
            });
        } catch (error) {
          failures.push(error);
        }
      }
      if (ownsControl) {
        for (const name of controlTables) {
          try {
            if (await native.tableExists(name))
              await native.executeYql({
                text: `DROP TABLE ${quote(name)};`,
                transactionMode: 'implicit',
                retry: false,
              });
          } catch (error) {
            failures.push(error);
          }
        }
      }
    }
    try {
      await native.close();
    } catch (error) {
      failures.push(error);
    }
    await rm(cwd, { recursive: true, force: true });
    if (failures.length)
      throw new AggregateError(failures, 'Integration fixture cleanup failed');
  }
  context.after(close);
  try {
    await mkdir(cwd, { recursive: true });
    const libraryManifest = JSON.parse(
      await readFile(
        join(repositoryRoot, 'packages/prisma-ydb/package.json'),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };
    await writeFile(
      join(cwd, 'package.json'),
      JSON.stringify({
        name: 'prisma-ydb-integration-fixture',
        private: true,
        type: 'module',
        dependencies: {
          'prisma-ydb': 'workspace:*',
          '@prisma/orm-family-sql':
            libraryManifest.dependencies['@prisma/orm-family-sql'],
          '@prisma/orm-framework':
            libraryManifest.dependencies['@prisma/orm-framework'],
        },
      }),
    );
    await writeFile(schemaPath, options.schema(table));
    await writeFile(
      configPath,
      `import {definePrismaConfig} from 'prisma/config';\nimport {defineYdbConfig} from 'prisma-ydb/config';\nimport {ydbBindingFromEnv} from 'prisma-ydb/environment';\nexport default definePrismaConfig({orm:defineYdbConfig({contract:'./contract.prisma',output:'./generated',migrations:{dir:'./migrations'},relationMode:'application',db:{connection:ydbBindingFromEnv()}})});\n`,
    );
    const emitted = await runPrisma(
      ['contract', 'emit', '--config', configPath],
      cwd,
    );
    if (emitted.code !== 0)
      throw new Error(
        `Integration contract emission failed:\n${emitted.stdout}\n${emitted.stderr}`,
      );
    const contractJson = JSON.parse(
      await readFile(join(cwd, 'generated', 'contract.json'), 'utf8'),
    );
    const contract = ydbContractSerializer.deserializeContract(contractJson);
    const expectedTables = Object.values(contract.storage.namespaces).flatMap(
      (namespace) => Object.keys(namespace.entries.table ?? {}),
    );
    if (expectedTables.some((name) => ![...names.values()].includes(name)))
      throw new Error(
        'Every integration model must use @@map(table(name)) so fixture cleanup owns a unique physical table.',
      );
    await native.connect(binding);
    connected = true;
    db = ydb({
      contractJson,
      binding,
      verifyMarker: false,
      driverOptions: {
        maxSessions: 2,
        minSessions: 0,
        queryTimeoutMs: 10_000,
        closeTimeoutMs: 5_000,
      },
    });
    await db.connect();
    const client = db;
    return {
      db: client,
      native,
      contractJson,
      table,
      cwd,
      configPath,
      schemaPath,
      close,
      ddl: (text: string) =>
        native.executeYql({ text, transactionMode: 'implicit', retry: false }),
      async prisma(args: readonly string[]) {
        if (args[0] === 'db' && args[1] === 'migrate' && !ownsControl) {
          for (const name of controlTables) {
            if (await native.tableExists(name))
              throw new Error(
                'Migration integration fixture requires a database without existing Prisma control tables; refusing to overwrite deployment metadata.',
              );
          }
          const existing = await listYdbTables(native.core);
          if (existing.some((name) => ![...names.values()].includes(name)))
            throw new Error(
              'Migration integration fixture requires an isolated database without unrelated tables.',
            );
          ownsControl = true;
        }
        return runPrisma([...args, '--config', configPath], cwd);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
