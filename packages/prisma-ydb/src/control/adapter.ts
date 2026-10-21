import type { SqlControlAdapter } from '@prisma/orm-family-sql/family/control-adapter';
import type { SqlControlDriverInstance } from '@prisma/orm-family-sql/contract/types';
import type {
  AnyQueryAst,
  DdlNode,
  LowererContext,
  LoweredStatement,
  SqlExecuteRequest,
} from '@prisma/orm-family-sql/relational-core/ast';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import { randomUUID } from 'node:crypto';
import { compileYql } from '../runtime/compiler.js';
import { requireYdbControlDriver } from './driver.js';
import {
  readAllYdbMarkers,
  readYdbLedger,
  readYdbMarker,
  writeYdbLedger,
  writeYdbMarker,
} from './metadata.js';
import { introspectYdb } from './schema.js';
import {
  acquireYdbMigrationLock,
  ensureYdbControlTables,
  releaseYdbMigrationLock,
} from './runner.js';

export class YdbControlAdapter implements SqlControlAdapter<'ydb'> {
  readonly familyId = 'sql' as const;
  readonly targetId = 'ydb' as const;
  bootstrapControlTableQueries(): readonly DdlNode[] {
    return [];
  }
  bootstrapSignMarkerQueries(): readonly DdlNode[] {
    return [];
  }
  lower(
    ast: AnyQueryAst | DdlNode,
    context: LowererContext<unknown>,
  ): LoweredStatement {
    if ('isDdlNode' in ast)
      throw new Error('Use native YDB migration operations to lower DDL.');
    return compileYql(ast, context.contract as Contract<SqlStorage>);
  }
  async lowerToExecuteRequest(
    ast: AnyQueryAst | DdlNode,
    context?: LowererContext<unknown>,
  ): Promise<SqlExecuteRequest> {
    if (!context)
      throw new Error('YDB control query lowering requires a contract.');
    const result = this.lower(ast, context);
    if (result.params.length)
      throw new Error(
        'Parameterized migration transforms require explicitly typed YQL through executeYql().',
      );
    return { sql: result.sql, params: [] };
  }
  async renderColumnDefault(): Promise<string> {
    throw new Error('Use native YDB column rendering in migration operations.');
  }
  readMarker(driver: SqlControlDriverInstance<'ydb'>, space: string) {
    return readYdbMarker(requireYdbControlDriver(driver), space);
  }
  readAllMarkers(driver: SqlControlDriverInstance<'ydb'>) {
    return readAllYdbMarkers(requireYdbControlDriver(driver));
  }
  readLedger(driver: SqlControlDriverInstance<'ydb'>, space?: string) {
    return readYdbLedger(requireYdbControlDriver(driver), space);
  }
  insertMarker(
    driver: SqlControlDriverInstance<'ydb'>,
    space: string,
    destination: Parameters<typeof writeYdbMarker>[2],
  ) {
    return writeYdbMarker(
      requireYdbControlDriver(driver),
      space,
      destination,
      true,
    );
  }
  initMarker(
    driver: SqlControlDriverInstance<'ydb'>,
    space: string,
    destination: Parameters<typeof writeYdbMarker>[2],
  ) {
    return writeYdbMarker(requireYdbControlDriver(driver), space, destination);
  }
  async updateMarker(
    driver: SqlControlDriverInstance<'ydb'>,
    space: string,
    expectedFrom: string,
    destination: Parameters<typeof writeYdbMarker>[2],
  ): Promise<boolean> {
    const native = requireYdbControlDriver(driver);
    const marker = await readYdbMarker(native, space);
    if (marker?.storageHash !== expectedFrom) return false;
    await writeYdbMarker(native, space, {
      ...destination,
      invariants: destination.invariants ?? marker.invariants,
    });
    return true;
  }
  writeLedgerEntry(
    driver: SqlControlDriverInstance<'ydb'>,
    space: string,
    entry: Parameters<typeof writeYdbLedger>[2],
  ) {
    return writeYdbLedger(requireYdbControlDriver(driver), space, entry);
  }
  async withTransaction<T>(
    driver: SqlControlDriverInstance<'ydb'>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const native = requireYdbControlDriver(driver);
    await ensureYdbControlTables(native);
    const owner = randomUUID();
    await acquireYdbMigrationLock(native, owner);
    let value: T;
    try {
      value = await native.withTransaction(fn);
    } catch (error) {
      try {
        await releaseYdbMigrationLock(native, owner);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'YDB control transaction and migration lock release both failed.',
        );
      }
      throw error;
    }
    await releaseYdbMigrationLock(native, owner);
    return value;
  }

  async lockMarker(): Promise<void> {
    /* withTransaction holds the durable migration lock. */
  }
  introspect(driver: SqlControlDriverInstance<'ydb'>) {
    return introspectYdb(requireYdbControlDriver(driver).core);
  }
}
