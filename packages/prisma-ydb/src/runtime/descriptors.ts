import { builtinGeneratorIds } from '@prisma/orm-framework/ids';
import { generateId } from '@prisma/orm-framework/ids/runtime';
import type { RuntimeDriverDescriptor } from '@prisma/orm-framework/components/execution';
import type { RuntimeMutationDefaultGenerator } from '@prisma/orm-framework/components/runtime';
import { timestampNowRuntimeGenerator } from '@prisma/orm-family-sql/family/runtime';
import { APP_SPACE_ID } from '@prisma/orm-framework/components/control';
import { Text } from '@ydbjs/value/primitive';
import {
  AggregateExpr,
  type MarkerReadResult,
  type SqlQueryable,
} from '@prisma/orm-family-sql/relational-core/ast';
import type { RawCodecInferer } from '@prisma/orm-family-sql/relational-core/expression';
import type { SqlAggregateDescriptor } from '@prisma/orm-family-sql/relational-core/aggregate-descriptor-registry';
import type {
  SqlRuntimeAdapterDescriptor,
  SqlRuntimeAdapterInstance,
  SqlRuntimeDriverInstance,
  SqlRuntimeTargetDescriptor,
} from '@prisma/orm-family-sql/runtime';
import { YdbDriver } from '../driver/index.js';
import type { YdbQueryRequest, YdbQueryResult } from '../driver/index.js';
import { decodeYdbMarkerRow, isYdbMissingTable } from '../control/metadata.js';
import {
  ydbCodecDescriptors,
  ydbDataTypes,
  type CodecTypes,
} from './codecs.js';
import { compileYql, unsupported } from './compiler.js';
import { ydbQueryOperations } from './operations.js';

export const ydbCapabilities = {
  sql: {
    returning: true,
    enums: false, // Enum metadata/types are supported; YDB does not enforce value sets.
    scalarList: true,
    defaultInInsert: false,
    lateral: false,
    checkConstraint: false,
    insertOnConflictSkip: false,
    insertOnConflictWithoutTarget: false,
    forUpdate: false,
    forShare: false,
    lockOf: false,
    lockNowait: false,
    lockSkipLocked: false,
  },
  ydb: { nativeYql: true, serializableTransactions: true },
} as const;

export const ydbAggregateDescriptors: readonly SqlAggregateDescriptor[] = [
  {
    operation: 'count',
    input: { kind: 'any' },
    output: { kind: 'codec', codecId: 'ydb/number@1' },
    nullable: false,
    emptyResultJson: '0',
  },
  {
    operation: 'countBigInt',
    input: { kind: 'any' },
    output: { kind: 'codec', codecId: 'ydb/uint64@1' },
    nullable: false,
    emptyResultJson: '0',
    lower: ({ expr }) => new AggregateExpr('count', expr),
  },
  ...(['min', 'max'] as const).map(
    (operation) =>
      ({
        operation,
        input: { kind: 'trait', trait: 'order' },
        output: { kind: 'self' },
        nullable: true,
      }) satisfies SqlAggregateDescriptor,
  ),
  ...(
    ['ydb/int32@1', 'ydb/int64@1', 'ydb/number@1', 'ydb/uint64@1'] as const
  ).flatMap((codecId) => [
    {
      operation: 'sum',
      input: { kind: 'codec', codecId },
      output: { kind: 'codec', codecId: 'ydb/number@1' },
      nullable: true,
    } satisfies SqlAggregateDescriptor,
    {
      operation: 'sumBigInt',
      input: { kind: 'codec', codecId },
      output: {
        kind: 'codec',
        codecId: codecId === 'ydb/uint64@1' ? 'ydb/uint64@1' : 'ydb/int64@1',
      },
      nullable: true,
      lower: ({ expr }) => new AggregateExpr('sum', expr),
    } satisfies SqlAggregateDescriptor,
    {
      operation: 'avg',
      input: { kind: 'codec', codecId },
      output: { kind: 'codec', codecId: 'ydb/double@1' },
      nullable: true,
    } satisfies SqlAggregateDescriptor,
  ]),
  ...(['sum', 'avg'] as const).map(
    (operation) =>
      ({
        operation,
        input: { kind: 'codec', codecId: 'ydb/double@1' },
        output: { kind: 'self' },
        nullable: true,
      }) satisfies SqlAggregateDescriptor,
  ),
];

export const ydbRawCodecInferer: RawCodecInferer = {
  inferCodec(value) {
    switch (typeof value) {
      case 'string':
        return 'ydb/utf8@1';
      case 'boolean':
        return 'ydb/bool@1';
      case 'bigint':
        return 'ydb/int64@1';
      case 'number':
        return Number.isInteger(value) ? 'ydb/number@1' : 'ydb/double@1';
      case 'object':
        if (value instanceof Date) return 'ydb/timestamp@1';
        if (value instanceof Uint8Array) return 'ydb/string@1';
    }
    return unsupported('untyped raw interpolation');
  },
};

export async function readYdbRuntimeMarker(
  queryable: SqlQueryable & {
    executeYql?(request: YdbQueryRequest): Promise<YdbQueryResult>;
    tableExists?(name: string): Promise<boolean>;
  },
): Promise<MarkerReadResult> {
  try {
    const rows: Record<string, unknown>[] = [];
    if (queryable.executeYql) {
      const result = await queryable.executeYql({
        text: 'DECLARE $space AS Utf8; SELECT * FROM `_prisma_marker` WHERE space = $space',
        parameters: { $space: new Text(APP_SPACE_ID) },
        transactionMode: 'snapshotReadOnly',
        idempotent: true,
      });
      rows.push(...result.resultSets.flatMap((set) => set.rows));
    } else {
      for await (const row of queryable.query({
        sql: 'DECLARE $p1 AS Utf8; $space = $p1; SELECT * FROM `_prisma_marker` WHERE space = $space',
        params: [new Text(APP_SPACE_ID)],
      }))
        rows.push(row);
    }
    return rows[0]
      ? { kind: 'present', record: decodeYdbMarkerRow(rows[0]) }
      : { kind: 'absent' };
  } catch (error) {
    const tableExists = queryable.tableExists?.bind(queryable);
    if (
      tableExists &&
      (await isYdbMissingTable(error, () => tableExists('_prisma_marker')))
    )
      return { kind: 'no-table' };
    throw error;
  }
}

export function createYdbRuntimeAdapter(options?: {
  readonly readMarker?: (queryable: SqlQueryable) => Promise<MarkerReadResult>;
}): SqlRuntimeAdapterInstance<'ydb'> {
  return {
    familyId: 'sql',
    targetId: 'ydb',
    profile: {
      id: 'ydb/native@1',
      target: 'ydb',
      capabilities: ydbCapabilities,
      readMarker: options?.readMarker ?? readYdbRuntimeMarker,
    },
    lower: (ast, context) => compileYql(ast, context.contract),
  };
}
export const ydbRuntimeTarget: SqlRuntimeTargetDescriptor<'ydb'> & {
  readonly __codecTypes?: CodecTypes;
} = {
  kind: 'target',
  familyId: 'sql',
  targetId: 'ydb',
  id: 'ydb',
  version: '0.0.1',
  dataTypes: ydbDataTypes,
  capabilities: {},
  codecs: () => [],
  create: () => ({ familyId: 'sql', targetId: 'ydb' }),
};
export const ydbRuntimeAdapter: SqlRuntimeAdapterDescriptor<'ydb'> = {
  kind: 'adapter',
  familyId: 'sql',
  targetId: 'ydb',
  id: 'ydb',
  version: '0.0.1',
  capabilities: ydbCapabilities,
  types: {
    aggregateDescriptors: ydbAggregateDescriptors,
    queryOperationTypes: {
      import: {
        package: 'prisma-ydb/runtime',
        named: 'QueryOperationTypes',
        alias: 'YdbQueryOperationTypes',
      },
    },
    codecTypes: {
      codecDescriptors: ydbCodecDescriptors,
      import: {
        package: 'prisma-ydb/runtime',
        named: 'CodecTypes',
        alias: 'YdbTypes',
      },
    },
  },
  codecs: () => ydbCodecDescriptors,
  rawCodecInferer: ydbRawCodecInferer,
  queryOperations: () => ydbQueryOperations,
  mutationDefaultGenerators: () => [
    ...builtinGeneratorIds.map(
      (id): RuntimeMutationDefaultGenerator => ({
        id,
        generate: (params) => generateId(params ? { id, params } : { id }),
        stability: 'field',
      }),
    ),
    timestampNowRuntimeGenerator(),
  ],
  create: () => createYdbRuntimeAdapter(),
};
export const ydbRuntimeDriver: RuntimeDriverDescriptor<
  'sql',
  'ydb',
  unknown,
  SqlRuntimeDriverInstance<'ydb'>
> = {
  kind: 'driver',
  familyId: 'sql',
  targetId: 'ydb',
  id: 'ydb',
  version: '0.0.1',
  capabilities: { sql: { transactions: true } },
  create: () =>
    Object.assign(new YdbDriver(), {
      familyId: 'sql' as const,
      targetId: 'ydb' as const,
    }),
};
