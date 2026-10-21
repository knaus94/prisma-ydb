import type {
  ContractMarkerRecord,
  LedgerEntryRecord,
} from '@prisma/orm-framework/contract/types';
import type { YdbQueryRequest, YdbQueryResult } from '../driver/types.js';
import { APP_SPACE_ID } from '@prisma/orm-framework/components/control';
import { StatusIds_StatusCode as Status } from '@ydbjs/api/operation';
import { YdbQueryError } from '../driver/errors.js';
import { Text } from '@ydbjs/value/primitive';

export interface YdbExecutor {
  executeYql(request: YdbQueryRequest): Promise<YdbQueryResult>;
  tableExists?(name: string): Promise<boolean>;
}

export const CONTROL_DDL = [
  'CREATE TABLE IF NOT EXISTS `_prisma_marker` (space Utf8 NOT NULL, core_hash Utf8 NOT NULL, profile_hash Utf8 NOT NULL, invariants Utf8 NOT NULL, updated_at Timestamp NOT NULL, PRIMARY KEY (space))',
  'CREATE TABLE IF NOT EXISTS `_prisma_ledger` (space Utf8 NOT NULL, edge_id Utf8 NOT NULL, migration_name Utf8 NOT NULL, migration_hash Utf8 NOT NULL, origin_hash Utf8, destination_hash Utf8 NOT NULL, operations Utf8 NOT NULL, contract_json Utf8, created_at Timestamp NOT NULL, PRIMARY KEY (space, edge_id))',
  'CREATE TABLE IF NOT EXISTS `_prisma_ydb_migrations` (plan_id Utf8 NOT NULL, operation_id Utf8 NOT NULL, statement_hash Utf8 NOT NULL, state Utf8 NOT NULL, updated_at Timestamp NOT NULL, PRIMARY KEY (plan_id, operation_id))',
  'CREATE TABLE IF NOT EXISTS `_prisma_ydb_lock` (id Utf8 NOT NULL, owner Utf8 NOT NULL, acquired_at Timestamp, host Utf8, pid Uint32, PRIMARY KEY (id))',
] as const;

export function textParameters(values: Record<string, string>): {
  prefix: string;
  parameters: Record<string, Text>;
} {
  const parameters: Record<string, Text> = {};
  let prefix = '';
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name))
      throw new Error('Invalid metadata parameter name.');
    parameters[`$${name}`] = new Text(value);
    prefix += `DECLARE $${name} AS Utf8;\n`;
  }
  return { prefix, parameters };
}

export async function metadataQuery(
  executor: YdbExecutor,
  text: string,
  values: Record<string, string> = {},
): Promise<Record<string, unknown>[]> {
  const args = textParameters(values);
  const result = await executor.executeYql({
    text: args.prefix + text,
    parameters: args.parameters,
  });
  return result.resultSets.flatMap((set) => set.rows);
}

export function decodeYdbMarkerRow(
  row: Record<string, unknown>,
): ContractMarkerRecord {
  const invariants: unknown = JSON.parse(String(row['invariants']));
  if (
    !Array.isArray(invariants) ||
    !invariants.every((value) => typeof value === 'string')
  )
    throw new Error('Malformed YDB contract marker invariants.');
  return {
    storageHash: String(row['core_hash']),
    profileHash: String(row['profile_hash']),
    invariants,
    updatedAt:
      row['updated_at'] instanceof Date
        ? row['updated_at']
        : new Date(
            typeof row['updated_at'] === 'bigint'
              ? Number(row['updated_at'] / 1000n)
              : String(row['updated_at']),
          ),
    canonicalVersion: null,
    contractJson: null,
    appTag: null,
    meta: {},
  };
}

/** Only a missing table is absence; permission/transport/corruption failures propagate. */
export async function isYdbMissingTable(
  error: unknown,
  tableExists: () => Promise<boolean>,
): Promise<boolean> {
  return (
    error instanceof YdbQueryError &&
    error.status === Status.SCHEME_ERROR &&
    !(await tableExists())
  );
}

export async function readYdbMarker(
  executor: YdbExecutor,
  space: string = APP_SPACE_ID,
): Promise<ContractMarkerRecord | null> {
  if (executor.tableExists && !(await executor.tableExists('_prisma_marker')))
    return null;
  try {
    const rows = await metadataQuery(
      executor,
      'SELECT * FROM `_prisma_marker` WHERE space = $space',
      { space },
    );
    return rows[0] ? decodeYdbMarkerRow(rows[0]) : null;
  } catch (error) {
    const tableExists = executor.tableExists?.bind(executor);
    if (
      tableExists &&
      (await isYdbMissingTable(error, () => tableExists('_prisma_marker')))
    )
      return null;
    throw error;
  }
}

export async function readAllYdbMarkers(
  executor: YdbExecutor,
): Promise<ReadonlyMap<string, ContractMarkerRecord>> {
  if (executor.tableExists && !(await executor.tableExists('_prisma_marker')))
    return new Map();
  try {
    const rows = await metadataQuery(
      executor,
      'SELECT * FROM `_prisma_marker`',
    );
    return new Map(
      rows.map((row) => [String(row['space']), decodeYdbMarkerRow(row)]),
    );
  } catch (error) {
    const tableExists = executor.tableExists?.bind(executor);
    if (
      tableExists &&
      (await isYdbMissingTable(error, () => tableExists('_prisma_marker')))
    )
      return new Map();
    throw error;
  }
}

export async function writeYdbMarker(
  executor: YdbExecutor,
  space: string,
  destination: {
    storageHash: string;
    profileHash: string;
    invariants?: readonly string[];
  },
  insertOnly = false,
): Promise<void> {
  await metadataQuery(
    executor,
    `${insertOnly ? 'INSERT' : 'UPSERT'} INTO \`_prisma_marker\` (space, core_hash, profile_hash, invariants, updated_at) VALUES ($space, $storage, $profile, $invariants, CurrentUtcTimestamp())`,
    {
      space,
      storage: destination.storageHash,
      profile: destination.profileHash,
      invariants: JSON.stringify(destination.invariants ?? []),
    },
  );
}

export async function readYdbLedger(
  executor: YdbExecutor,
  space?: string,
): Promise<readonly LedgerEntryRecord[]> {
  if (executor.tableExists && !(await executor.tableExists('_prisma_ledger')))
    return [];
  try {
    const rows = await metadataQuery(
      executor,
      `SELECT * FROM \`_prisma_ledger\`${space ? ' WHERE space = $space' : ''} ORDER BY created_at, edge_id`,
      space ? { space } : {},
    );
    return rows.map((row) => ({
      space: String(row['space']),
      migrationName: String(row['migration_name']),
      migrationHash: String(row['migration_hash']),
      from: row['origin_hash'] ? String(row['origin_hash']) : null,
      to: String(row['destination_hash']),
      appliedAt:
        row['created_at'] instanceof Date
          ? row['created_at']
          : new Date(
              typeof row['created_at'] === 'bigint'
                ? Number(row['created_at'] / 1000n)
                : String(row['created_at']),
            ),
      operationCount: (JSON.parse(String(row['operations'])) as unknown[])
        .length,
    }));
  } catch (error) {
    const tableExists = executor.tableExists?.bind(executor);
    if (
      tableExists &&
      (await isYdbMissingTable(error, () => tableExists('_prisma_ledger')))
    )
      return [];
    throw error;
  }
}

export async function writeYdbLedger(
  executor: YdbExecutor,
  space: string,
  entry: {
    edgeId: string;
    from: string;
    to: string;
    migrationName: string;
    migrationHash: string;
    operations: readonly unknown[];
    destinationContractJson?: unknown;
  },
): Promise<void> {
  await metadataQuery(
    executor,
    'INSERT INTO `_prisma_ledger` (space,edge_id,migration_name,migration_hash,origin_hash,destination_hash,operations,contract_json,created_at) VALUES ($space,$edge,$name,$hash,$from,$to,$operations,$contract,CurrentUtcTimestamp())',
    {
      space,
      edge: entry.edgeId,
      name: entry.migrationName,
      hash: entry.migrationHash,
      from: entry.from,
      to: entry.to,
      operations: JSON.stringify(entry.operations),
      contract: JSON.stringify(entry.destinationContractJson ?? null),
    },
  );
}
