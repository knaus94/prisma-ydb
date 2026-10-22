import type { SqlOperationDescriptors } from '@prisma/orm-family-sql/operations';
import {
  buildOperation,
  codecOf,
  toExpr,
  type Expression,
  type ScopeField,
} from '@prisma/orm-family-sql/relational-core/expression';
import type { AnyExpression } from '@prisma/orm-family-sql/relational-core/ast';
import { encodeYdbJson } from './codecs.js';

export type YdbJsonPath = string | readonly (string | number)[];

const arrayIndex = /^\d+$/;
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function pathText(path: YdbJsonPath): string {
  const segments = typeof path === 'string' ? path.split('.') : path;
  if (!Array.isArray(segments) || !segments.length)
    throw new TypeError('JSON paths require at least one segment');
  return (
    'strict $' +
    segments
      .map((segment) => {
        if (
          typeof segment === 'number' ||
          (typeof path === 'string' && arrayIndex.test(segment))
        ) {
          const index = Number(segment);
          if (!Number.isSafeInteger(index) || index < 0)
            throw new TypeError(
              'JSON array indices must be nonnegative safe integers',
            );
          return `[${index}]`;
        }
        if (
          typeof segment !== 'string' ||
          !segment ||
          hasControlCharacter(segment)
        )
          throw new TypeError(
            'JSON path keys must be nonempty and contain no control characters',
          );
        return '.' + JSON.stringify(segment);
      })
      .join('')
  );
}

function operation<Id extends string>(
  self: Expression<ScopeField>,
  method: string,
  template: string,
  codecId: Id,
  args: readonly AnyExpression[] = [],
) {
  return buildOperation({
    method,
    args: [self.buildAst(), ...args],
    returns: { codecId, nullable: true as const },
    lowering: { targetFamily: 'sql', template },
  });
}

function jsonValue<Id extends string>(
  self: Expression<ScopeField>,
  path: YdbJsonPath,
  type: string,
  codecId: Id,
) {
  return operation(
    self,
    'jsonValue',
    `JSON_VALUE({{self}}, ${JSON.stringify(pathText(path))} RETURNING ${type} NULL ON EMPTY NULL ON ERROR)`,
    codecId,
  );
}

function exists(self: Expression<ScopeField>, path: string) {
  return operation(
    self,
    'jsonExists',
    `JSON_EXISTS({{self}}, ${JSON.stringify(path)})`,
    'ydb/bool@1',
  );
}

function listCodec(self: Expression<ScopeField>) {
  const codec = codecOf(self);
  if (!codec || !(codec.many || self.returnType.many))
    throw new TypeError('List filters require a list field');
  return codec;
}

function listNeedle(
  codec: ReturnType<typeof listCodec>,
  value: unknown,
): AnyExpression {
  if (value === null)
    throw new TypeError('List filters do not accept null elements');
  const json = encodeYdbJson(codec.codecId, value, codec.typeParams);
  if (json === null || typeof json === 'object')
    throw new TypeError('List filters require scalar JSON elements');
  if (typeof json === 'string') return toExpr(json, { codecId: 'ydb/utf8@1' });
  if (typeof json === 'boolean') return toExpr(json, { codecId: 'ydb/bool@1' });
  if (codec.codecId === 'ydb/double@1')
    return toExpr(json, { codecId: 'ydb/double@1' });
  return toExpr(BigInt(json), { codecId: 'ydb/int64@1' });
}

function listFilter(
  self: Expression<ScopeField>,
  method: string,
  values: readonly unknown[],
  conjunction: 'AND' | 'OR',
) {
  const codec = listCodec(self);
  if (!Array.isArray(values)) throw new TypeError(`${method} expects an array`);
  const args = values.map((value) => listNeedle(codec, value));
  const template = args.length
    ? '(' +
      args
        .map(
          (_arg, index) =>
            `JSON_EXISTS({{self}}, "strict $[*] ? (@ == $v0)" PASSING {{arg${index}}} AS v0)`,
        )
        .join(` ${conjunction} `) +
      ')'
    : `IF({{self}} IS NULL, NULL, ${conjunction === 'AND' ? 'TRUE' : 'FALSE'})`;
  return operation(self, method, template, 'ydb/bool@1', args);
}

/** Explicit operation helpers also work where rc.18 does not expose field methods. */
export const ydbQueryOperations = {
  jsonString: {
    self: { codecId: 'ydb/json@1' },
    impl: (self: Expression<ScopeField>, path: YdbJsonPath) =>
      jsonValue(self, path, 'Utf8', 'ydb/utf8@1'),
  },
  jsonNumber: {
    self: { codecId: 'ydb/json@1' },
    impl: (self: Expression<ScopeField>, path: YdbJsonPath) =>
      jsonValue(self, path, 'Double', 'ydb/double@1'),
  },
  jsonBoolean: {
    self: { codecId: 'ydb/json@1' },
    impl: (self: Expression<ScopeField>, path: YdbJsonPath) =>
      jsonValue(self, path, 'Bool', 'ydb/bool@1'),
  },
  jsonExists: {
    self: { codecId: 'ydb/json@1' },
    impl: (self: Expression<ScopeField>, path: YdbJsonPath) =>
      exists(self, pathText(path)),
  },
  jsonIsNull: {
    self: { codecId: 'ydb/json@1' },
    impl: (self: Expression<ScopeField>, path: YdbJsonPath) =>
      exists(self, pathText(path) + ' ? (@ == null)'),
  },
  has: {
    self: { many: true },
    impl: (self: Expression<ScopeField>, value: unknown) =>
      listFilter(self, 'has', [value], 'OR'),
  },
  hasSome: {
    self: { many: true },
    impl: (self: Expression<ScopeField>, values: readonly unknown[]) =>
      listFilter(self, 'hasSome', values, 'OR'),
  },
  hasEvery: {
    self: { many: true },
    impl: (self: Expression<ScopeField>, values: readonly unknown[]) =>
      listFilter(self, 'hasEvery', values, 'AND'),
  },
  isEmpty: {
    self: { many: true },
    impl: (self: Expression<ScopeField>) => {
      listCodec(self);
      return operation(
        self,
        'isEmpty',
        'NOT JSON_EXISTS({{self}}, "$[0]")',
        'ydb/bool@1',
      );
    },
  },
} as const satisfies SqlOperationDescriptors;
