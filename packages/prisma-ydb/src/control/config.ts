import { extname, join } from 'node:path';
import type { PrismaNextConfig } from '@prisma/orm-framework/config/config-types';
import type {
  ControlAdapterDescriptor,
  ControlTargetDescriptor,
  MigratableTargetDescriptor,
} from '@prisma/orm-framework/components/control';
import { UNBOUND_NAMESPACE_ID } from '@prisma/orm-framework/components/ir';
import { dataTypeId } from '@prisma/orm-framework/components/codec';
import type {
  DataTypeAuthoringEntry,
  AuthoringTypeNamespace,
} from '@prisma/orm-framework/components/authoring';
import {
  temporalAuthoringPresets,
  temporalCodecPreset,
  type AuthoringModelAttributeContext,
} from '@prisma/orm-framework/components/authoring';
import {
  modelAttribute,
  identifier,
  str,
} from '@prisma/orm-framework/psl-parser';
import sql from '@prisma/orm-family-sql/family/control';
import { prismaContract } from '@prisma/orm-family-sql/contract-psl/provider';
import {
  createNumberClassifier,
  signedRange,
  parseJsonText,
  printJsonText,
} from '@prisma/orm-family-sql/contract/data-type-support';
import { typescriptContractFromPath } from '@prisma/orm-family-sql/contract-ts/config-types';
import {
  relationalNodeEntityKind,
  relationalNodeGranularity,
} from '@prisma/orm-family-sql/schema-ir/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import type { Contract } from '@prisma/orm-framework/contract/types';
import {
  ydbCodecDescriptors,
  ydbDataTypes,
  ydbScalarDescriptors,
  ydbUint64,
} from '../runtime/codecs.js';
import {
  ydbCapabilities,
  ydbAggregateDescriptors,
} from '../runtime/descriptors.js';
import type { YdbBinding } from '../driver/types.js';
import {
  ydbContractSerializer,
  ydbCreateNamespace,
  YDB_TEMPORAL_CODECS,
  ydbDurationSeconds,
} from './contract.js';
import { ydbMutationDefaults } from './defaults.js';
import { ydbQueryOperations } from '../runtime/operations.js';
import { ydbControlDriverDescriptor } from './driver.js';
import { YdbControlAdapter } from './adapter.js';
import { diffYdbSchema, ydbContractToSchema } from './schema.js';
import { YdbMigrationPlanner } from './planner.js';
import { YdbMigrationRunner } from './runner.js';
import { inferYdbPsl, printYdbPsl } from './psl.js';
import { dateText, timestampText } from '../runtime/temporal.js';
import { ydbCreateApplicationRelationsNamespace } from './relations.js';

// SQL's Char/VarChar field presets require fixed-width semantics YDB Utf8 does not provide.
// Keep the SQL family machinery, and expose only this target's native authoring types.
const ydbSqlFamily: typeof sql = Object.assign(Object.create(sql), {
  authoring: { ...sql.authoring, type: {}, field: {} },
});

const ttlAttribute = {
  kind: 'modelAttribute' as const,
  attribute: 'ttl',
  spec: () =>
    modelAttribute('ttl', {
      documentation: 'Asynchronous row expiry.',
      named: {
        field: { type: identifier(), documentation: 'Temporal model field.' },
        expireAfter: {
          type: str(),
          documentation: 'ISO-8601 expiry duration.',
        },
      },
    }),
  lower(
    parsed: { field: string; expireAfter: string },
    context: AuthoringModelAttributeContext,
  ) {
    try {
      const column = context.fieldStorageName(parsed.field);
      const codec = context.fieldCodecId(parsed.field);
      if (!column || !codec || !YDB_TEMPORAL_CODECS.has(codec))
        throw new Error(
          `@@ttl requires a temporal field (${context.modelName}.${parsed.field}).`,
        );
      return {
        key: context.storageName,
        entity: {
          table: context.storageName,
          column,
          expireAfterSeconds: ydbDurationSeconds(parsed.expireAfter),
        },
      };
    } catch (error) {
      context.diagnostics?.push({
        code: 'YDB.TTL_INVALID',
        message: error instanceof Error ? error.message : String(error),
        sourceId: context.sourceId ?? '<ydb>',
      });
      return undefined;
    }
  },
};

const authoringDataTypes: Readonly<Record<string, DataTypeAuthoringEntry>> = {
  'ydb/date': {
    documentation: 'YDB calendar day in UTC.',
    written: { kind: 'tag', tag: 'date', parse: dateText },
    print: String,
  },
  'ydb/timestamp': {
    documentation: 'YDB UTC timestamp.',
    written: { kind: 'tag', tag: 'timestamp', parse: timestampText },
    print: String,
  },
  'ydb/utf8': {
    documentation: 'YDB Unicode text.',
    written: { kind: 'plain', syntax: 'string', parse: (text) => text },
    print: String,
  },
  'ydb/bool': {
    documentation: 'YDB boolean.',
    written: {
      kind: 'plain',
      syntax: 'boolean',
      parse: (text) => {
        if (text !== 'true' && text !== 'false')
          throw new Error('Expected true or false.');
        return text === 'true';
      },
    },
    print: String,
  },
  'ydb/double': {
    documentation: 'YDB exact-width numbers.',
    written: {
      kind: 'plain',
      syntax: 'number',
      types: [
        dataTypeId('ydb/int32'),
        dataTypeId('ydb/int64'),
        dataTypeId('ydb/double'),
      ],
      classify: createNumberClassifier({
        integers: [
          { type: dataTypeId('ydb/int32'), form: 'number', ...signedRange(32) },
          { type: dataTypeId('ydb/int64'), form: 'text', ...signedRange(64) },
        ],
        fraction: { type: dataTypeId('ydb/double'), form: 'number' },
      }),
    },
    print: String,
  },
  'ydb/decimal': {
    documentation: 'Exact fixed-precision decimal.',
    written: {
      kind: 'tag',
      tag: 'decimal',
      parse: (value) => {
        if (!/^-?\d+(?:\.\d+)?$/.test(value))
          throw new TypeError('Expected an exact decimal string');
        return value;
      },
    },
    print: String,
  },
  'ydb/json': {
    documentation: 'YDB JSON document.',
    written: { kind: 'tag', tag: 'json', parse: parseJsonText },
    print: printJsonText,
  },
};

const types = Object.fromEntries(
  Object.entries({ ...ydbScalarDescriptors, Uint64: ydbUint64 }).map(
    ([name, descriptor]) => [
      name,
      {
        kind: 'typeConstructor',
        ...(name === 'Timestamp' ? {} : { inferred: true }),
        ...(name === 'Decimal'
          ? {
              args: [
                {
                  kind: 'number',
                  integer: true,
                  minimum: 1,
                  maximum: 35,
                  optional: true,
                },
                {
                  kind: 'number',
                  integer: true,
                  minimum: 0,
                  maximum: 35,
                  optional: true,
                },
              ],
            }
          : {}),
        output: {
          codecId: descriptor.codecId,
          ...(name === 'Decimal'
            ? {
                typeParams: {
                  precision: { kind: 'arg', index: 0 },
                  scale: { kind: 'arg', index: 1 },
                },
              }
            : {}),
        },
      },
    ],
  ),
) as AuthoringTypeNamespace;

export const ydbControlTarget = {
  kind: 'target',
  id: 'ydb',
  familyId: 'sql',
  targetId: 'ydb',
  version: '0.0.1',
  defaultNamespaceId: UNBOUND_NAMESPACE_ID,
  supportsNamespaces: false,
  queryOperations: () => ydbQueryOperations,
  contractSerializer: ydbContractSerializer,
  create: () => ({ familyId: 'sql' as const, targetId: 'ydb' as const }),
  classifySubjectGranularity: relationalNodeGranularity,
  classifyEntityKind: relationalNodeEntityKind,
  diffSchema: diffYdbSchema,
  inferPslContract: inferYdbPsl,
  buildPslContract: (contract: Contract<SqlStorage>) =>
    printYdbPsl(
      contract,
      ydbContractToSchema(contract, [ydbControlAdapterDescriptor]),
    ),
  migrations: {
    createPlanner: () => new YdbMigrationPlanner(),
    createRunner: () => new YdbMigrationRunner(),
    contractToSchema: (contract, components) =>
      ydbContractToSchema(contract as Contract<SqlStorage> | null, components),
  },
} satisfies ControlTargetDescriptor<'sql', 'ydb'> &
  MigratableTargetDescriptor<'sql', 'ydb'> & {
    inferPslContract: typeof inferYdbPsl;
    buildPslContract: (
      contract: Contract<SqlStorage>,
    ) => ReturnType<typeof printYdbPsl>;
    diffSchema: typeof diffYdbSchema;
    classifySubjectGranularity: typeof relationalNodeGranularity;
    classifyEntityKind: typeof relationalNodeEntityKind;
    queryOperations: () => typeof ydbQueryOperations;
  };

export const ydbControlAdapterDescriptor: ControlAdapterDescriptor<
  'sql',
  'ydb',
  YdbControlAdapter
> = {
  kind: 'adapter',
  id: 'ydb',
  familyId: 'sql',
  targetId: 'ydb',
  version: '0.0.1',
  capabilities: ydbCapabilities,
  types: {
    codecTypes: {
      codecDescriptors: ydbCodecDescriptors,
      import: {
        package: 'prisma-ydb/runtime',
        named: 'CodecTypes',
        alias: 'YdbCodecTypes',
      },
    },
    aggregateDescriptors: ydbAggregateDescriptors,
    queryOperationTypes: {
      import: {
        package: 'prisma-ydb/runtime',
        named: 'QueryOperationTypes',
        alias: 'YdbQueryOperationTypes',
      },
    },
  },
  dataTypes: ydbDataTypes,
  authoring: {
    type: types,
    field: {
      temporal: {
        ...temporalAuthoringPresets({ codecId: 'ydb/timestamp@1' }),
        DateTime: temporalCodecPreset({ codecId: 'ydb/timestamp@1' }),
        Timestamp: temporalCodecPreset({ codecId: 'ydb/timestamp-us@1' }),
        Date: temporalCodecPreset({ codecId: 'ydb/date@1' }),
      },
    },
    modelAttributes: { ttl: ttlAttribute },
    valueObjectStorageType: 'Json',
    dataTypes: authoringDataTypes,
  },
  controlMutationDefaults: ydbMutationDefaults,
  create: () => new YdbControlAdapter(),
};

export interface YdbConfigOptions {
  readonly contract: string;
  readonly output?: string;
  readonly db?: { readonly connection?: YdbBinding | string };
  readonly migrations?: { readonly dir?: string };
  /** PSL relations are query metadata; the application owns referential integrity. */
  readonly relationMode?: 'application';
}

export function defineYdbConfig(
  options: YdbConfigOptions,
): PrismaNextConfig<'sql', 'ydb', string> {
  if (
    options.relationMode !== undefined &&
    options.relationMode !== 'application'
  ) {
    throw new TypeError('YDB relationMode must be application when provided.');
  }
  const output = join(
    options.output ?? './prisma/ydb/generated',
    'contract.json',
  );
  const binding = options.db?.connection;
  const connection = typeof binding === 'string' ? binding : binding?.url;
  // Prisma's db verify entry point currently requires a string connection. Keep auth/TLS
  // configuration in the driver's factory closure while preserving --db URL overrides.
  const driver = {
    ...ydbControlDriverDescriptor,
    create: (
      url: string,
      connectOptions?: Parameters<typeof ydbControlDriverDescriptor.create>[1],
    ) =>
      ydbControlDriverDescriptor.create(
        typeof binding === 'object' ? { ...binding, url } : url,
        connectOptions,
      ),
  };
  return {
    family: ydbSqlFamily,
    target: ydbControlTarget,
    adapter: ydbControlAdapterDescriptor,
    driver,
    contract:
      extname(options.contract) === '.ts'
        ? typescriptContractFromPath(options.contract, output)
        : prismaContract(options.contract, {
            output,
            target: ydbControlTarget,
            createNamespace:
              options.relationMode === 'application'
                ? ydbCreateApplicationRelationsNamespace
                : ydbCreateNamespace,
            enumInferenceCodecs: { text: 'ydb/utf8@1', int: 'ydb/int32@1' },
          }),
    ...(connection ? { db: { connection } } : {}),
    ...(options.migrations ? { migrations: options.migrations } : {}),
  };
}
