import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { ok, notOk } from '@prisma/orm-framework/utils/result';
import type {
  MigrationRunner,
  MigrationRunnerResult,
  MigrationPlanOperation,
} from '@prisma/orm-framework/components/control';
import type { Contract } from '@prisma/orm-framework/contract/types';
import { diffSchemas } from '@prisma/orm-framework/components/control';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import { requireYdbControlDriver, type YdbControlDriver } from './driver.js';
import {
  CONTROL_DDL,
  metadataQuery,
  readYdbMarker,
  readYdbLedger,
  writeYdbMarker,
  writeYdbLedger,
} from './metadata.js';
import {
  describeYdbTable,
  introspectYdb,
  introspectYdbTable,
  ydbContractToSchema,
} from './schema.js';
import {
  matchesTableShape,
  tableShape,
  type YdbMigrationOperation,
} from './planner.js';

const hash = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function operation(value: MigrationPlanOperation): YdbMigrationOperation {
  if (!('target' in value) || !('meta' in value) || !('execute' in value))
    throw new Error(
      'YDB migrations require native operations with drift checkpoints.',
    );
  const op = value as YdbMigrationOperation;
  if (
    op.target.id !== 'ydb' ||
    typeof op.target.details?.table !== 'string' ||
    !op.target.details.table ||
    !op.meta ||
    op.execute.length !== 1 ||
    typeof op.execute[0]?.sql !== 'string' ||
    !op.execute[0].sql.trim()
  )
    throw new Error('Malformed YDB operation.');
  if (op.precheck?.length !== 0 || op.postcheck?.length !== 0)
    throw new Error(
      'YDB uses schema checkpoints or transactional verification SQL; generic precheck/postcheck payloads are unsupported.',
    );
  if (op.meta.ydbKind === 'data') {
    if (
      op.operationClass !== 'data' ||
      typeof op.meta.ydbVerifySql !== 'string' ||
      !op.meta.ydbVerifySql.trim()
    )
      throw new Error(
        'Data operations require an explicit verification query.',
      );
  } else if (
    op.operationClass === 'data' ||
    !('ydbBefore' in op.meta) ||
    !('ydbAfter' in op.meta)
  )
    throw new Error(
      'Schema operations require before/after drift checkpoints.',
    );
  return op;
}

async function markApplied(
  driver: YdbControlDriver,
  planId: string,
  operationId: string,
  statementHash: string,
): Promise<void> {
  await metadataQuery(
    driver,
    'UPSERT INTO `_prisma_ydb_migrations` (plan_id,operation_id,statement_hash,state,updated_at) VALUES ($plan,$operation,$hash,"applied"u,CurrentUtcTimestamp())',
    { plan: planId, operation: operationId, hash: statementHash },
  );
}

const LOCK_COLUMNS = [
  ['acquired_at', 'Timestamp'],
  ['host', 'Utf8'],
  ['pid', 'Uint32'],
] as const;

export async function ensureYdbControlTables(
  driver: YdbControlDriver,
): Promise<void> {
  for (const sql of CONTROL_DDL) await driver.executeDdl(sql);
  const table = await describeYdbTable(driver.core, '_prisma_ydb_lock');
  const columns = new Set(table.columns.map((column) => column.name));
  const missing = LOCK_COLUMNS.filter(([name]) => !columns.has(name));
  if (!missing.length) return;
  try {
    await driver.executeDdl(
      'ALTER TABLE `_prisma_ydb_lock` ' +
        missing
          .map(([name, type]) => `ADD COLUMN \`${name}\` ${type}`)
          .join(', '),
    );
  } catch (error) {
    const latest = await describeYdbTable(driver.core, '_prisma_ydb_lock');
    if (
      !LOCK_COLUMNS.every(([name]) =>
        latest.columns.some((column) => column.name === name),
      )
    )
      throw error;
  }
}

export async function acquireYdbMigrationLock(
  driver: YdbControlDriver,
  owner: string,
): Promise<void> {
  try {
    await metadataQuery(
      driver,
      'INSERT INTO `_prisma_ydb_lock` (id,owner,acquired_at,host,pid) VALUES ("migrations"u,$owner,CurrentUtcTimestamp(),$host,CAST($pid AS Uint32))',
      { owner, host: hostname(), pid: String(process.pid) },
    );
  } catch (cause) {
    const current = await metadataQuery(
      driver,
      'SELECT * FROM `_prisma_ydb_lock` WHERE id = "migrations"u',
    );
    const row = current[0];
    const timestamp = row?.['acquired_at'];
    const acquiredAt =
      timestamp === null || timestamp === undefined
        ? undefined
        : timestamp instanceof Date
          ? timestamp
          : new Date(
              typeof timestamp === 'bigint'
                ? Number(timestamp / 1000n)
                : String(timestamp),
            );
    const validDate = acquiredAt && Number.isFinite(acquiredAt.getTime());
    const acquired = validDate ? acquiredAt.toISOString() : 'unknown';
    const age = validDate
      ? `${Math.max(0, Date.now() - acquiredAt.getTime())}ms`
      : 'unknown';
    throw new Error(
      `Cannot acquire YDB migration lock; current owner ${String(row?.['owner'] ?? 'unknown')}, host ${String(row?.['host'] ?? 'unknown')}, pid ${String(row?.['pid'] ?? 'unknown')}, acquired_at ${acquired}, age ${age}. A crashed owner requires explicit release after verifying no migration process is active.`,
      { cause },
    );
  }
}

/** Explicit operator recovery: only release the owner printed by a failed deployment. */
export async function releaseYdbMigrationLock(
  driver: YdbControlDriver,
  owner: string,
): Promise<void> {
  await driver.withTransaction(async () => {
    const rows = await metadataQuery(
      driver,
      'SELECT owner FROM `_prisma_ydb_lock` WHERE id = "migrations"u',
    );
    if (rows[0] && rows[0]['owner'] !== owner)
      throw new Error('Migration lock owner changed; refusing to release it.');
    await metadataQuery(
      driver,
      'DELETE FROM `_prisma_ydb_lock` WHERE id = "migrations"u AND owner = $owner',
      { owner },
    );
  });
}

/** YDB schema operations are not transactional. Each step is journaled and verified. */
export class YdbMigrationRunner implements MigrationRunner<'sql', 'ydb'> {
  async execute(
    options: Parameters<MigrationRunner<'sql', 'ydb'>['execute']>[0],
  ): Promise<MigrationRunnerResult> {
    const driver = requireYdbControlDriver(options.driver);
    if (options.perSpaceOptions.length > 1)
      return notOk({
        code: 'YDB.MULTISPACE_MIGRATION_UNSUPPORTED',
        summary:
          'YDB DDL cannot atomically apply multiple contract spaces. Apply each space separately.',
      });
    await ensureYdbControlTables(driver);
    const owner = randomUUID();
    let acquired = false;
    let failingSpace: string | undefined;
    let outcome: MigrationRunnerResult | undefined;
    try {
      await acquireYdbMigrationLock(driver, owner);
      acquired = true;
      const perSpaceResults = [];
      for (const spaceOptions of options.perSpaceOptions) {
        failingSpace = spaceOptions.space;
        const plan = spaceOptions.plan;
        if (
          plan.targetId !== 'ydb' ||
          (plan.spaceId && plan.spaceId !== spaceOptions.space)
        )
          throw new Error('Migration target or contract space mismatch.');
        const contract =
          spaceOptions.destinationContract as Contract<SqlStorage>;
        if (
          String(contract.storage.storageHash) !== plan.destination.storageHash
        )
          throw new Error(
            'Migration destination does not match the contract hash.',
          );
        const expected = ydbContractToSchema(
          contract,
          spaceOptions.frameworkComponents,
        );
        const operations = (await Promise.all(plan.operations)).map(operation);
        for (const op of operations)
          if (
            !spaceOptions.policy.allowedOperationClasses.includes(
              op.operationClass,
            )
          )
            throw new Error(
              `Policy refuses ${op.operationClass} operation ${op.id}.`,
            );
        const marker = await readYdbMarker(driver, spaceOptions.space);
        if (
          spaceOptions.migrationEdges.length > 0 &&
          !plan.origin &&
          marker &&
          marker.storageHash !== plan.destination.storageHash
        )
          throw new Error(
            'Baseline migration requires an unsigned database or its exact destination marker.',
          );
        if (
          marker?.storageHash !== plan.destination.storageHash &&
          plan.origin &&
          marker?.storageHash !== plan.origin.storageHash
        )
          throw new Error(
            `YDB marker is not at expected origin ${plan.origin.storageHash}.`,
          );
        const planId = hash({
          space: spaceOptions.space,
          origin: plan.origin,
          destination: plan.destination,
          operations,
        });
        const edges = spaceOptions.migrationEdges;
        if (
          edges.length &&
          edges.reduce((total, edge) => total + edge.operationCount, 0) !==
            operations.length
        )
          throw new Error(
            'Migration edge operation counts do not match the plan.',
          );
        const appliedEdges = new Set(
          (await readYdbLedger(driver, spaceOptions.space)).map(
            (edge) => edge.migrationHash,
          ),
        );
        let executed = 0;
        for (const [index, op] of operations.entries()) {
          // Journal identity is tied to immutable migration packages, so splitting
          // or combining a deployment path cannot repeat committed data steps.
          let localIndex = index;
          const edge = edges.find((candidate) => {
            if (localIndex < candidate.operationCount) return true;
            localIndex -= candidate.operationCount;
            return false;
          });
          if (edge && appliedEdges.has(edge.migrationHash)) continue;
          if (
            op.meta.ydbKind !== 'data' &&
            marker?.storageHash === plan.destination.storageHash
          )
            continue;
          const journalPlanId = edge
            ? `edge:${spaceOptions.space}:${edge.migrationHash}`
            : planId;
          const operationId = `${localIndex}:${op.id}`;
          const statementHash = hash(op);
          const journal = await metadataQuery(
            driver,
            'SELECT * FROM `_prisma_ydb_migrations` WHERE plan_id = $plan AND operation_id = $operation',
            { plan: journalPlanId, operation: operationId },
          );
          if (journal[0] && journal[0]['statement_hash'] !== statementHash)
            throw new Error(`Journal checksum mismatch for ${operationId}.`);
          // A later step on this table may already have advanced beyond this checkpoint.
          // Every applied record is checksum-bound; the next unfinished step and final
          // destination verification still check the live schema before metadata advances.
          if (journal[0]?.['state'] === 'applied') continue;
          if (journal[0] && journal[0]['state'] !== 'started')
            throw new Error(`Unknown journal state for ${operationId}.`);
          const statement = op.execute[0];
          if (!statement)
            throw new Error(`Missing statement at ${operationId}.`);
          if (op.meta.ydbKind === 'data') {
            const verifySql = op.meta.ydbVerifySql;
            await driver.withTransaction(async () => {
              await driver.executeYql({ text: statement.sql });
              const verified = await driver.executeYql({ text: verifySql });
              const rows = verified.resultSets.flatMap((set) => set.rows);
              if (rows.length !== 1 || rows[0]?.['ok'] !== true)
                throw new Error(
                  `Data verification failed at ${operationId}; return exactly one row with boolean column ok = true. The transformation is rolled back.`,
                );
              await markApplied(
                driver,
                journalPlanId,
                operationId,
                statementHash,
              );
            });
            executed++;
            continue;
          }
          let live = tableShape(
            await introspectYdbTable(driver.core, op.target.details.table),
          );
          if (journal[0] && matchesTableShape(live, op.meta.ydbAfter)) {
            await markApplied(
              driver,
              journalPlanId,
              operationId,
              statementHash,
            );
            continue;
          }
          if (!matchesTableShape(live, op.meta.ydbBefore))
            throw new Error(
              `Schema drift at ${operationId} (plan ${journalPlanId}); live table matches neither the migration's expected start nor its recorded completed state.`,
            );
          await metadataQuery(
            driver,
            'UPSERT INTO `_prisma_ydb_migrations` (plan_id,operation_id,statement_hash,state,updated_at) VALUES ($plan,$operation,$hash,"started"u,CurrentUtcTimestamp())',
            {
              plan: journalPlanId,
              operation: operationId,
              hash: statementHash,
            },
          );
          await driver.executeDdl(statement.sql);
          live = tableShape(
            await introspectYdbTable(driver.core, op.target.details.table),
          );
          if (!matchesTableShape(live, op.meta.ydbAfter))
            throw new Error(
              `DDL completed but schema verification failed at ${operationId}. Marker remains unchanged; inspect the journal and live schema before retry.`,
            );
          await markApplied(driver, journalPlanId, operationId, statementHash);
          executed++;
        }
        const schema = await introspectYdb(driver.core);
        const issues = diffSchemas(expected, schema);
        if (issues.length)
          throw new Error(
            `Destination schema verification failed: ${JSON.stringify(issues)}. YDB DDL already applied is not rolled back.`,
          );
        await driver.withTransaction(async () => {
          const latest = await readYdbMarker(driver, spaceOptions.space);
          if (
            latest?.storageHash !== marker?.storageHash ||
            latest?.profileHash !== marker?.profileHash
          )
            throw new Error('Contract marker changed during migration.');
          const invariants = [
            ...new Set([
              ...(latest?.invariants ?? []),
              ...(plan.providedInvariants ?? []),
            ]),
          ];
          if (
            latest?.storageHash !== plan.destination.storageHash ||
            latest.profileHash !== String(contract.profileHash) ||
            JSON.stringify(latest.invariants) !== JSON.stringify(invariants)
          ) {
            await writeYdbMarker(driver, spaceOptions.space, {
              storageHash: plan.destination.storageHash,
              profileHash: String(contract.profileHash),
              invariants,
            });
          }
          const currentEdges = new Set(
            (await readYdbLedger(driver, spaceOptions.space)).map(
              (edge) => edge.migrationHash,
            ),
          );
          let offset = 0;
          for (const edge of spaceOptions.migrationEdges) {
            const edgeOperations = operations.slice(
              offset,
              offset + edge.operationCount,
            );
            offset += edge.operationCount;
            if (currentEdges.has(edge.migrationHash)) continue;
            await writeYdbLedger(driver, spaceOptions.space, {
              edgeId: edge.migrationHash,
              from: edge.from,
              to: edge.to,
              migrationName: edge.dirName,
              migrationHash: edge.migrationHash,
              operations: edgeOperations,
              ...(edge.destinationContractJson !== undefined
                ? { destinationContractJson: edge.destinationContractJson }
                : {}),
            });
          }
        });
        perSpaceResults.push({
          space: spaceOptions.space,
          value: {
            operationsPlanned: operations.length,
            operationsExecuted: executed,
          },
        });
      }
      outcome = ok({ perSpaceResults });
    } catch (error) {
      outcome = notOk({
        code: 'YDB.MIGRATION_FAILED',
        summary: error instanceof Error ? error.message : String(error),
        why: 'YDB DDL is not transactional. Applied schema steps remain durable; the marker advances only after full verification. Retry the unchanged migration to resume from its journal.',
        ...(failingSpace ? { failingSpace } : {}),
      });
    } finally {
      if (acquired) {
        try {
          await releaseYdbMigrationLock(driver, owner);
        } catch (error) {
          outcome = notOk({
            code: 'YDB.MIGRATION_LOCK_CLEANUP_FAILED',
            summary: `Could not release migration lock owned by ${owner}. Inspect status before explicitly releasing it.`,
            meta: {
              owner,
              cleanupError:
                error instanceof Error ? error.message : String(error),
              migrationOutcome: outcome,
            },
          });
        }
      }
    }
    if (!outcome)
      throw new Error('Migration runner completed without a result.');
    return outcome;
  }
}
