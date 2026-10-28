import type { SqlOperationDescriptors } from '@prisma/orm-family-sql/operations';
import {
  buildOperation,
  codecOf,
  toExpr,
  type Expression,
  type ScopeField,
} from '@prisma/orm-family-sql/relational-core/expression';
import type {
  AnyExpression,
  AnyQueryAst,
} from '@prisma/orm-family-sql/relational-core/ast';
import { encodeYdbJson, encodeYdbValue } from './codecs.js';
import { defineAnnotation } from '@prisma/orm-framework/components/runtime';
import type { SqlMiddleware } from '@prisma/orm-family-sql/runtime';
import {
  ParamRef,
  LiteralExpr,
} from '@prisma/orm-family-sql/relational-core/ast';
import { List } from '@ydbjs/value/list';
import { Tuple } from '@ydbjs/value/tuple';

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

/** Explicit index selection through Prisma's native read annotation surface. */
export const ydbView = defineAnnotation<string>()({
  namespace: 'prisma-ydb/view',
  applicableTo: ['read'],
});

// Weak keys retain no query/contract once the corresponding AST is released.
const readViews = new WeakMap<AnyQueryAst, string>();
export function viewForAst(ast: AnyQueryAst): string | undefined {
  return readViews.get(ast);
}

/** Shared by client runtimes and offline compiler harnesses. */
export const ydbReadMiddleware: SqlMiddleware = {
  name: 'prisma-ydb/read-annotations',
  familyId: 'sql',
  targetId: 'ydb',
  async beforeCompile(draft) {
    if (draft.meta.annotations?.['prisma-ydb/view'] === undefined) return;
    const view = ydbView.read(draft);
    if (typeof view !== 'string' || !view)
      throw new TypeError('ydbView requires an index name');
    if (draft.ast.kind !== 'select' || draft.ast.from?.kind !== 'table-source')
      throw new TypeError('ydbView requires a root table SELECT');
    const ast = Object.assign(
      Object.create(Object.getPrototypeOf(draft.ast)),
      draft.ast,
    ) as AnyQueryAst;
    readViews.set(ast, view);
    return { ...draft, ast };
  },
};

/** A typed tuple-list predicate for a primary key or secondary-index prefix. */
export function whereKeys<Scope extends Record<string, Expression<ScopeField>>>(
  scope: Scope,
  keys: readonly { readonly [Field in keyof Scope]?: unknown }[],
): Expression<{ codecId: 'ydb/bool@1'; nullable: false }> {
  if (!Array.isArray(keys)) throw new TypeError('whereKeys requires an array');
  if (!keys.length)
    return buildOperation({
      method: 'whereKeys',
      args: [LiteralExpr.of(false)],
      returns: { codecId: 'ydb/bool@1', nullable: false },
      lowering: { targetFamily: 'sql', template: 'FALSE' },
    });
  const names = Object.keys(keys[0] ?? {});
  if (!names.length) throw new TypeError('whereKeys requires nonempty keys');
  const expressions = names.map((name) => {
    const field = scope[name];
    if (!field) throw new TypeError(`Unknown whereKeys field ${name}`);
    const ast = field.buildAst();
    const codec = codecOf(field);
    if (
      ast.kind !== 'column-ref' ||
      !codec ||
      codec.many ||
      field.returnType.nullable
    )
      throw new TypeError(
        `whereKeys requires nonnullable scalar columns: ${name}`,
      );
    return { ast, codec };
  });
  const rows = keys.map((key) => {
    if (
      Object.keys(key).length !== names.length ||
      names.some((name) => !Object.hasOwn(key, name))
    )
      throw new TypeError('whereKeys rows must have the same fields');
    return new Tuple(
      ...expressions.map(({ codec }, index) => {
        const value = key[names[index]!];
        if (value === null || value === undefined)
          throw new TypeError('whereKeys values cannot be null');
        return encodeYdbValue(codec.codecId, value, codec.typeParams);
      }),
    );
  });
  return buildOperation({
    method: 'whereKeys',
    args: [
      expressions[0]!.ast,
      ...expressions.slice(1).map(({ ast }) => ast),
      ParamRef.of(new List(...rows)),
    ],
    returns: { codecId: 'ydb/bool@1', nullable: false },
    lowering: {
      targetFamily: 'sql',
      template: `AsTuple(${expressions.map((_field, index) => (index ? `{{arg${index - 1}}}` : '{{self}}')).join(', ')}) IN {{arg${expressions.length - 1}}}`,
    },
  });
}
