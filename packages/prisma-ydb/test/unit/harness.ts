import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import { AsyncIterableResult } from '@prisma/orm-framework/components/runtime';
import { orm } from '@prisma/orm-family-sql/orm-client';
import type {
  SqlQueryPlan,
  SqlOrmPlan,
} from '@prisma/orm-family-sql/relational-core/plan';
import {
  createExecutionContext,
  createSqlExecutionStack,
  type RuntimeQueryable,
} from '@prisma/orm-family-sql/runtime';
import { ydbContractSerializer } from 'prisma-ydb/control';
import {
  compileYql,
  ydbRuntimeAdapter,
  ydbRuntimeDriver,
  ydbRuntimeTarget,
} from 'prisma-ydb/runtime';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const require = createRequire(import.meta.url);
const prismaManifestPath = require.resolve('prisma/package.json');
const prismaCli = resolve(
  dirname(prismaManifestPath),
  (
    JSON.parse(await readFile(prismaManifestPath, 'utf8')) as {
      bin: { prisma: string };
    }
  ).bin.prisma,
);

/** Emit a contract from PSL without a database, then lower ORM plans offline. */
export async function compileHarness(
  context: Pick<TestContext, 'after'>,
  schema: string,
) {
  const contractJson = await emitContract(context, schema);
  return compileHarnessFromContract(contractJson);
}

async function emitContract(
  context: Pick<TestContext, 'after'>,
  schema: string,
): Promise<unknown> {
  const cwd = join(
    repositoryRoot,
    'tmp',
    `unit_${randomUUID().replaceAll('-', '')}`,
  );
  context.after(() => rm(cwd, { recursive: true, force: true }));
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
      name: 'prisma-ydb-unit-fixture',
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
  await writeFile(join(cwd, 'contract.prisma'), schema);
  const configPath = join(cwd, 'prisma.config.mjs');
  await writeFile(
    configPath,
    `import {definePrismaConfig} from 'prisma/config';\nimport {defineYdbConfig} from 'prisma-ydb/config';\nexport default definePrismaConfig({orm:defineYdbConfig({contract:'./contract.prisma',output:'./generated',migrations:{dir:'./migrations'},relationMode:'application',db:{connection:'grpc://127.0.0.1:1/unit'}})});\n`,
  );
  const emitted = await new Promise<{ code: number; output: string }>(
    (done, fail) => {
      execFile(
        process.execPath,
        [prismaCli, 'contract', 'emit', '--config', configPath],
        { cwd, env: process.env, timeout: 60_000 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') fail(error);
          else done({ code: error?.code ?? 0, output: stdout + stderr });
        },
      );
    },
  );
  if (emitted.code !== 0)
    throw new Error(`Contract emission failed:\n${emitted.output}`);
  return JSON.parse(
    await readFile(join(cwd, 'generated', 'contract.json'), 'utf8'),
  );
}

/** Lower ORM plans against an already emitted contract; no CLI, no database. */
export function compileHarnessFromContract(contractJson: unknown) {
  const contract =
    ydbContractSerializer.deserializeContract<Contract<SqlStorage>>(
      contractJson,
    );
  const stack = createSqlExecutionStack({
    target: ydbRuntimeTarget,
    adapter: ydbRuntimeAdapter,
    driver: ydbRuntimeDriver,
    extensions: [],
  });
  const context_ = createExecutionContext<Contract<SqlStorage>, 'ydb'>({
    contract,
    stack,
    driver: ydbRuntimeDriver,
  });
  const compiled: string[] = [];
  const lower = (plan: SqlOrmPlan<unknown> | SqlQueryPlan) =>
    compileYql((plan as SqlQueryPlan).ast, contract).sql;
  const samples: Record<string, unknown> = {
    'ydb/utf8@1': 'x',
    'ydb/uuid@1': '00000000-0000-0000-0000-000000000000',
    'ydb/int32@1': 1,
    'ydb/number@1': 1,
    'ydb/int64@1': 1n,
    'ydb/uint64@1': 1n,
    'ydb/bool@1': true,
    'ydb/double@1': 1.5,
    'ydb/timestamp@1': new Date(0),
    'ydb/timestamp-us@1': '1970-01-01T00:00:00.000000Z',
    'ydb/date@1': '1970-01-01',
    'ydb/json@1': {},
    'ydb/string@1': new Uint8Array(),
    'ydb/decimal@1': '0',
  };
  /** One plausible row so multi-step ORM mutations proceed past their probe reads. */
  const sampleRow = (plan: SqlQueryPlan): Record<string, unknown> => {
    const row: Record<string, unknown> = {};
    if (plan.ast.kind !== 'select') return row;
    const tables =
      Object.values(contract.storage.namespaces)[0]?.entries.table ?? {};
    for (const item of plan.ast.projection) {
      const expr = item.expr;
      if (expr.kind !== 'column-ref') {
        row[item.alias] = null;
        continue;
      }
      const column = Object.values(tables)
        .map((table) => table.columns[expr.column])
        .find(Boolean);
      row[item.alias] = column?.many
        ? []
        : column
          ? samples[column.codecId]
          : null;
    }
    return row;
  };
  const runtime: RuntimeQueryable = {
    query(plan) {
      compiled.push(lower(plan));
      const row = sampleRow(plan as SqlQueryPlan);
      return new AsyncIterableResult(
        (async function* () {
          yield row;
        })(),
      );
    },
    async execute(plan) {
      compiled.push(lower(plan));
      return { affectedRows: 0 };
    },
  };
  const client = orm<Contract<SqlStorage>>({ context: context_, runtime });
  const namespace = Object.keys(contract.domain.namespaces)[0]!;
  const models = (client as unknown as Record<string, Record<string, unknown>>)[
    namespace
  ]!;
  /** Run an ORM call against the capturing runtime and return the last YQL it compiled. */
  const sql = async (run: () => Promise<unknown>): Promise<string> => {
    compiled.length = 0;
    try {
      await run();
    } catch (error) {
      if (compiled.length) return compiled.at(-1)!;
      throw error;
    }
    if (!compiled.length) throw new Error('No statement was compiled');
    return compiled.at(-1)!;
  };
  return { contract, models, sql };
}
