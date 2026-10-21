import { APP_SPACE_ID } from '@prisma/orm-framework/components/control';
import type { Contract } from '@prisma/orm-framework/contract/types';
import type {
  MigrationPlanner,
  MigrationPlanWithAuthoringSurface,
  MigrationPlannerResult,
  MigrationOperationClass,
  MigrationScaffoldContext,
  MigrationPlan,
} from '@prisma/orm-framework/components/control';
import { Migration } from '@prisma/orm-toolchain/migration-tools/migration';
import { UNBOUND_NAMESPACE_ID } from '@prisma/orm-framework/components/ir';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import {
  SqlSchemaIR,
  type SqlTableIR,
} from '@prisma/orm-family-sql/schema-ir/types';
import { ydbContractSerializer, quoteYdbIdentifier as q } from './contract.js';
import {
  ydbContractToSchema,
  renderYdbColumn,
  renderYdbLiteral,
} from './schema.js';

interface TableShape {
  columns: Record<
    string,
    { type: string; nullable: boolean; default: unknown }
  >;
  primaryKey: readonly string[];
  indexes: {
    name: string;
    columns: readonly string[] | undefined;
    unique: boolean;
  }[];
  uniques: { columns: readonly string[] }[];
}

export function stableShape(value: unknown): string {
  const ordered = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(ordered)
      : input !== null && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, ordered(child)]),
          )
        : input;
  return JSON.stringify(ordered(value));
}

/** Stable, persisted shapes used to detect drift and resolve ambiguous DDL outcomes. */
export function tableShape(table: SqlTableIR | undefined): unknown {
  if (!table) return null;
  return {
    columns: Object.fromEntries(
      Object.entries(table.columns)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, column]) => [
          name,
          {
            type: column.nativeType,
            nullable: column.nullable,
            default: column.resolvedDefault ?? null,
          },
        ]),
    ),
    primaryKey: table.primaryKey?.columns ?? [],
    indexes: table.indexes
      .map((index) => ({
        name: index.name,
        columns: index.columns,
        unique: index.unique,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    uniques: table.uniques
      .map((unique) => ({ columns: unique.columns }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}

export interface YdbMigrationOperation {
  readonly id: string;
  readonly label: string;
  readonly operationClass: MigrationOperationClass;
  readonly invariantId?: string;
  readonly target: {
    readonly id: 'ydb';
    readonly details: { readonly table: string };
  };
  readonly precheck: readonly [];
  readonly execute: readonly {
    readonly description: string;
    readonly sql: string;
  }[];
  readonly postcheck: readonly [];
  readonly meta:
    | {
        readonly ydbKind?: 'schema';
        readonly ydbBefore: unknown;
        readonly ydbAfter: unknown;
      }
    | { readonly ydbKind: 'data'; readonly ydbVerifySql: string };
}

/** A reviewed DML transformation and an assertion executed in the same transaction. */
export function ydbDataOperation(input: {
  id: string;
  table: string;
  sql: string;
  verifySql: string;
  label?: string;
  invariantId?: string;
}): YdbMigrationOperation {
  if (!input.id || !input.table || !input.sql.trim() || !input.verifySql.trim())
    throw new Error(
      'A YDB data operation requires id, table, SQL, and verification SQL.',
    );
  const invariantId = input.invariantId ?? `ydb:data:${input.id}`;
  if (!invariantId || /[\p{Cc}\p{White_Space}]/u.test(invariantId))
    throw new Error(
      'Data migration invariant IDs cannot be empty or contain whitespace/control characters.',
    );
  return {
    id: input.id,
    label: input.label ?? input.id,
    operationClass: 'data',
    invariantId,
    target: { id: 'ydb', details: { table: input.table } },
    precheck: [],
    execute: [{ description: input.label ?? input.id, sql: input.sql }],
    postcheck: [],
    meta: { ydbKind: 'data', ydbVerifySql: input.verifySql },
  };
}

/** One reviewed DDL statement with persisted before/after schema checkpoints. */
export function ydbSchemaOperation(input: {
  id: string;
  table: string;
  sql: string;
  before?: SqlTableIR;
  after?: SqlTableIR;
  operationClass: Exclude<MigrationOperationClass, 'data'>;
  label?: string;
}): YdbMigrationOperation {
  if (!input.id || !input.table || !input.sql.trim())
    throw new Error('A YDB schema operation requires id, table, and SQL.');
  if (
    (input.before && input.before.name !== input.table) ||
    (input.after && input.after.name !== input.table)
  )
    throw new Error('Schema checkpoints must describe the operation table.');
  return {
    id: input.id,
    label: input.label ?? input.id,
    operationClass: input.operationClass,
    target: { id: 'ydb', details: { table: input.table } },
    precheck: [],
    execute: [{ description: input.label ?? input.id, sql: input.sql }],
    postcheck: [],
    meta: {
      ydbBefore: tableShape(input.before),
      ydbAfter: tableShape(input.after),
    },
  };
}

export class YdbMigration extends Migration<
  YdbMigrationOperation,
  'sql',
  'ydb'
> {
  readonly targetId = 'ydb';
  readonly spaceId = APP_SPACE_ID;
  get operations(): readonly YdbMigrationOperation[] {
    return [];
  }
}

function renderPlan(plan: MigrationPlan): string {
  return `import { YdbMigration, MigrationCLI } from 'prisma-ydb/control';\n\nexport default class YdbAuthoredMigration extends YdbMigration {\n  override readonly spaceId = ${JSON.stringify(plan.spaceId ?? APP_SPACE_ID)};\n  override describe() { return ${JSON.stringify({ from: plan.origin?.storageHash ?? null, to: plan.destination.storageHash })}; }\n  override get operations() { return ${JSON.stringify(plan.operations, null, 2)} as const; }\n}\n\nawait MigrationCLI.run(import.meta.url, YdbAuthoredMigration);\n`;
}

function planShape(
  origin: MigrationPlan['origin'],
  destination: MigrationPlan['destination'],
  spaceId: string,
  operations: readonly YdbMigrationOperation[],
): MigrationPlanWithAuthoringSurface {
  const plan = {
    targetId: 'ydb',
    origin,
    destination,
    spaceId,
    operations,
    providedInvariants: [],
  };
  return { ...plan, renderTypeScript: () => renderPlan(plan) };
}

function createTable(table: SqlTableIR): string {
  const definitions = Object.values(table.columns).map(renderYdbColumn);
  if (!table.primaryKey?.columns.length)
    throw new Error(`YDB table ${table.name} requires a primary key.`);
  definitions.push(
    `PRIMARY KEY (${table.primaryKey.columns.map(q).join(', ')})`,
  );
  for (const index of table.indexes) {
    if (!index.columns?.length)
      throw new Error(`Index ${index.name} requires columns.`);
    definitions.push(
      `INDEX ${q(index.name)} GLOBAL SYNC ON (${index.columns.map(q).join(', ')})`,
    );
  }
  for (const [index, unique] of table.uniques.entries())
    definitions.push(
      `INDEX ${q(unique.name ?? `${table.name}_unique_${index}`)} GLOBAL UNIQUE SYNC ON (${unique.columns.map(q).join(', ')})`,
    );
  return `CREATE TABLE ${q(table.name)} (${definitions.join(', ')})`;
}

export class YdbMigrationPlanner implements MigrationPlanner<'sql', 'ydb'> {
  emptyMigration(
    context: MigrationScaffoldContext,
    spaceId: string,
  ): MigrationPlanWithAuthoringSurface {
    return planShape(
      context.fromHash ? { storageHash: context.fromHash } : null,
      { storageHash: context.toHash },
      spaceId,
      [],
    );
  }
  plan(
    options: Parameters<MigrationPlanner<'sql', 'ydb'>['plan']>[0],
  ): MigrationPlannerResult {
    try {
      if (options.statements.length)
        throw new Error(
          'YDB migration rename/backfill/convert statements require explicit, reviewed YQL migrations; automatic statement translation is not implemented.',
        );
      const contract: Contract<SqlStorage> =
        ydbContractSerializer.deserializeContract(
          ydbContractSerializer.serializeContract(
            options.contract as Contract<SqlStorage>,
          ),
        );
      const expected = ydbContractToSchema(
        contract,
        options.frameworkComponents,
      );
      if (!(options.schema instanceof SqlSchemaIR))
        throw new Error('Expected the native YDB schema IR.');
      const actual = options.schema;
      const operations: YdbMigrationOperation[] = [];
      const dataLoss: import('@prisma/orm-framework/components/control').MigrationDataLoss[] =
        [];
      const temporaryValues: import('@prisma/orm-framework/components/control').MigrationTemporaryValue[] =
        [];
      for (const name of [
        ...new Set([
          ...Object.keys(expected.tables),
          ...Object.keys(actual.tables),
        ]),
      ].sort()) {
        const before = actual.tables[name];
        const after = expected.tables[name];
        const desired = tableShape(after) as TableShape | null;
        let state = tableShape(before) as TableShape | null;
        if (stableShape(state) === stableShape(desired)) continue;
        const step = (
          sql: string,
          operationClass: MigrationOperationClass,
          next: TableShape | null,
          lostStorage?: string,
        ): void => {
          if (!options.policy.allowedOperationClasses.includes(operationClass))
            throw new Error(
              `Migration policy refuses ${operationClass} change to ${name}.`,
            );
          const opIndex = operations.length;
          operations.push({
            id: `table.${name}.${opIndex}`,
            label: sql,
            operationClass,
            target: { id: 'ydb', details: { table: name } },
            precheck: [],
            execute: [{ description: sql, sql }],
            postcheck: [],
            meta: { ydbBefore: state, ydbAfter: next },
          });
          if (lostStorage)
            dataLoss.push({
              operationIndex: opIndex,
              subject: { kind: 'storage', name: lostStorage },
              loss: 'drop',
              label: sql,
            });
          state = next;
        };
        const clone = (): TableShape =>
          JSON.parse(JSON.stringify(state)) as TableShape;
        if (!before && after) {
          step(createTable(after), 'additive', desired);
          continue;
        }
        if (before && !after) {
          // The ownership oracle may protect an externally managed sibling contract.
          if (
            options.ownership?.declaresEntity({
              namespaceId: UNBOUND_NAMESPACE_ID,
              entityKind: 'table',
              entityName: name,
            })
          )
            continue;
          step(`DROP TABLE ${q(name)}`, 'destructive', null, name);
          continue;
        }
        if (!before || !after || !desired || !state)
          throw new Error('Invalid YDB schema diff state.');
        if (
          JSON.stringify(before.primaryKey?.columns) !==
          JSON.stringify(after.primaryKey?.columns)
        )
          throw new Error(
            `Changing the primary key of ${name} requires a reviewed table reconstruction.`,
          );
        // Remove obsolete indexes before their columns. Each DDL gets its own durable checkpoint.
        const oldIndexes = new Map(
          before.indexes.map((index) => [index.name, index]),
        );
        const newIndexes = new Map(
          after.indexes.map((index) => [index.name, index]),
        );
        for (const [indexName, old] of oldIndexes) {
          const replacement = newIndexes.get(indexName);
          if (
            !replacement ||
            JSON.stringify(old.columns) !== JSON.stringify(replacement.columns)
          ) {
            const next = clone();
            next.indexes = next.indexes.filter(
              (index) => index.name !== indexName,
            );
            step(
              `ALTER TABLE ${q(name)} DROP INDEX ${q(indexName)}`,
              'destructive',
              next,
            );
          }
        }
        for (const unique of before.uniques) {
          if (
            !after.uniques.some(
              (candidate) =>
                JSON.stringify(candidate.columns) ===
                JSON.stringify(unique.columns),
            )
          ) {
            if (!unique.name)
              throw new Error(
                `Cannot discover the physical name of a unique index on ${name}.`,
              );
            const next = clone();
            next.uniques = next.uniques.filter(
              (entry) =>
                JSON.stringify(entry.columns) !==
                JSON.stringify(unique.columns),
            );
            step(
              `ALTER TABLE ${q(name)} DROP INDEX ${q(unique.name)}`,
              'destructive',
              next,
            );
          }
        }
        for (const column of Object.values(after.columns)) {
          const old = before.columns[column.name];
          if (!old) {
            if (!column.nullable && !column.resolvedDefault)
              throw new Error(
                `Adding required column ${name}.${column.name} needs an explicit literal default for existing rows.`,
              );
            const next = clone();
            const desiredColumn = desired.columns[column.name];
            if (!desiredColumn)
              throw new Error(`Missing desired column ${column.name}.`);
            next.columns[column.name] = desiredColumn;
            step(
              `ALTER TABLE ${q(name)} ADD COLUMN ${renderYdbColumn(column)}`,
              'additive',
              next,
            );
            if (!column.nullable && column.resolvedDefault?.kind === 'literal')
              temporaryValues.push({
                operationIndex: operations.length - 1,
                subject: { kind: 'storage', name: `${name}.${column.name}` },
                value: renderYdbLiteral(
                  column.resolvedDefault.value,
                  column.nativeType,
                ),
              });
            continue;
          }
          if (old.nativeType !== column.nativeType)
            throw new Error(
              `Changing ${name}.${column.name} from ${old.nativeType} to ${column.nativeType} requires a reviewed data migration; YDB cannot alter a row-table column type in place.`,
            );
          if (old.nullable && !column.nullable)
            throw new Error(
              `Setting NOT NULL on ${name}.${column.name} requires table reconstruction with verified data; automatic reconstruction is not implemented.`,
            );
          if (!old.nullable && column.nullable) {
            const next = clone();
            const changedColumn = next.columns[column.name];
            if (!changedColumn)
              throw new Error(`Missing current column ${column.name}.`);
            changedColumn.nullable = true;
            step(
              `ALTER TABLE ${q(name)} ALTER COLUMN ${q(column.name)} DROP NOT NULL`,
              'widening',
              next,
            );
          }
          if (
            JSON.stringify(old.resolvedDefault ?? null) !==
            JSON.stringify(column.resolvedDefault ?? null)
          ) {
            const def = column.resolvedDefault;
            if (
              def?.kind === 'function' ||
              old.resolvedDefault?.kind === 'function'
            )
              throw new Error(
                `Changing sequence defaults requires an explicit sequence migration (${name}.${column.name}).`,
              );
            const next = clone();
            const changedColumn = next.columns[column.name];
            if (!changedColumn)
              throw new Error(`Missing current column ${column.name}.`);
            changedColumn.default = def ?? null;
            step(
              `ALTER TABLE ${q(name)} ALTER COLUMN ${q(column.name)} ${def ? 'SET DEFAULT ' + renderYdbLiteral(def.value, column.nativeType) : 'DROP DEFAULT'}`,
              'additive',
              next,
            );
          }
        }
        for (const column of Object.keys(before.columns))
          if (!after.columns[column]) {
            const next = clone();
            delete next.columns[column];
            step(
              `ALTER TABLE ${q(name)} DROP COLUMN ${q(column)}`,
              'destructive',
              next,
              `${name}.${column}`,
            );
          }
        for (const [indexName, index] of newIndexes) {
          const old = oldIndexes.get(indexName);
          if (
            !old ||
            JSON.stringify(index.columns) !== JSON.stringify(old.columns)
          ) {
            const desiredIndex = desired.indexes.find(
              (entry) => entry.name === indexName,
            );
            if (!desiredIndex || !index.columns?.length)
              throw new Error(
                `Missing column definition for index ${indexName}.`,
              );
            const next = clone();
            next.indexes.push(desiredIndex);
            next.indexes.sort((a, b) => a.name.localeCompare(b.name));
            step(
              `ALTER TABLE ${q(name)} ADD INDEX ${q(indexName)} GLOBAL SYNC ON (${index.columns.map(q).join(', ')})`,
              'additive',
              next,
            );
          }
        }
        for (const unique of after.uniques) {
          if (
            !before.uniques.some(
              (candidate) =>
                JSON.stringify(candidate.columns) ===
                JSON.stringify(unique.columns),
            )
          ) {
            throw new Error(
              `YDB 26.2 cannot add a unique index to existing table ${name} with ALTER TABLE. Declare uniqueness at CREATE TABLE or perform a reviewed table reconstruction.`,
            );
          }
        }
        if (stableShape(state) !== stableShape(desired))
          throw new Error(
            `Unrecognized schema difference on ${name}; refusing to advance the marker.`,
          );
      }
      return {
        kind: 'success',
        plan: planShape(
          options.origin,
          {
            storageHash: String(contract.storage.storageHash),
            profileHash: String(contract.profileHash),
          },
          options.spaceId,
          operations,
        ),
        appliedStatements: [],
        dataLoss,
        accessWidening: [],
        temporaryValues,
      };
    } catch (error) {
      return {
        kind: 'failure',
        conflicts: [
          {
            kind: 'ydbUnsupportedChange',
            summary: error instanceof Error ? error.message : String(error),
          },
        ],
      };
    }
  }
}
