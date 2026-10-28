export { ydb, ydb as default } from './client.js';
export type {
  YdbClient,
  YdbEnums,
  YdbModelRows,
  YdbOptions,
  YdbQueryMembers,
  YdbTransactionContext,
  YdbTransactionOptions,
} from './client.js';
export type { YdbBulkUpsertOptions, YdbBulkUpsertResult } from './bulk.js';
export type {
  YdbChangeBatch,
  YdbChangefeedDecodeError,
  YdbChangePartitionBatch,
  YdbChangeEvent,
  YdbChangefeedOptions,
  YdbChangefeedPartition,
  YdbChangefeedPartitionControl,
  YdbChangefeedStartPosition,
} from './changefeed.js';
export type { YdbTransactionMode } from '../driver/index.js';
export {
  YdbCodecDescriptor,
  ydbUtf8,
  ydbUuid,
  ydbInt32,
  ydbInt64,
  ydbUint64,
  ydbNumber,
  ydbBool,
  ydbDouble,
  ydbTimestamp,
  ydbDate,
  ydbTimestampUs,
  ydbJson,
  ydbString,
  ydbDecimal,
  ydbCodecDescriptors,
  ydbDataTypes,
  ydbScalarDescriptors,
  yqlTypeForCodec,
  nativeCodecConversions,
  optional,
  list,
  struct,
  type YdbTypeDescriptor,
  type YdbTypeInput,
  type YdbTypeOutput,
  type NativeCodecConversions,
  type CodecTypes,
} from './codecs.js';
export { DecimalValue, DecimalType } from './decimal.js';
export { UuidValue } from '../driver/uuid.js';
export {
  TimestampMicrosValue,
  timestampFromMicros,
  timestampMicros,
  timestampText,
} from './temporal.js';
export {
  ydbQueryOperations,
  ydbView,
  whereKeys,
  ydbReadMiddleware,
  type YdbJsonPath,
} from './operations.js';
export type QueryOperationTypes<
  CT extends Record<
    string,
    { readonly input: unknown; readonly output: unknown }
  >,
> = import('@prisma/orm-family-sql/contract/types').SqlQueryOperationTypes<
  CT,
  typeof import('./operations.js').ydbQueryOperations
>;
export { compileYql, quoteYqlIdentifier } from './compiler.js';
export {
  ydbCapabilities,
  ydbAggregateDescriptors,
  ydbRuntimeAdapter,
  ydbRuntimeTarget,
  ydbRuntimeDriver,
} from './descriptors.js';
export {
  Bool,
  Bytes,
  Double,
  Float,
  Int8,
  Int16,
  Int32,
  Int64,
  Uint8,
  Uint16,
  Uint32,
  Uint64,
  Json,
  JsonDocument,
  Text,
  Utf8,
  Timestamp,
  Date as YdbDate,
  Datetime,
  Uuid,
} from '@ydbjs/value/primitive';
export { Optional } from '@ydbjs/value/optional';
export { List } from '@ydbjs/value/list';
export { Struct } from '@ydbjs/value/struct';

export { topicClient } from './topic.js';
export {
  yqlModel,
  type YdbModelName,
  type YdbYqlColumn,
  type YdbYqlModel,
  type YdbYqlInput,
  type YdbYqlOutput,
} from './yql-model.js';
export {
  classifyYdbError,
  type YdbErrorClassification,
  withRetry,
  type WithRetryOptions,
} from '../driver/index.js';

export { ydbContract } from './contract.js';
export {
  yqlStatement,
  columns,
  type YdbYqlParams,
  type YdbYqlValues,
  type YdbYqlResults,
  type YdbYqlResultSpec,
  type YdbYqlResultRows,
  type YdbYqlStatementOptions,
  type YdbYqlQueryable,
  type YdbYqlStatementResult,
  type YdbYqlStatement,
} from './yql-statement.js';

export type { YdbIndexScanOptions, YdbIndexScanResult } from './keys.js';

export {
  defineYql,
  type YqlFunction,
  type YqlTypedMember,
} from './define-yql.js';
export type { JsonValue } from '@prisma/orm-framework/contract/types';
