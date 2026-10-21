import type {
  ControlMutationDefaults,
  ControlMutationDefaultEntry,
  LoweredDefaultResult,
} from '@prisma/orm-framework/components/control';
import { builtinGeneratorRegistryMetadata } from '@prisma/orm-framework/ids';
import { int, num, oneOf, optional } from '@prisma/orm-framework/psl-parser';

const generator = (
  id: string,
  params?: Record<string, unknown>,
): LoweredDefaultResult => ({
  ok: true,
  value: {
    kind: 'execution',
    generated: { kind: 'generator', id, ...(params ? { params } : {}) },
  },
});

export const ydbMutationDefaults: ControlMutationDefaults = {
  defaultFunctionRegistry: new Map<string, ControlMutationDefaultEntry>([
    [
      'autoincrement',
      {
        signature: {},
        lower: () => ({
          ok: true,
          value: {
            kind: 'storage',
            defaultValue: { kind: 'function', expression: 'autoincrement()' },
          },
        }),
        usageSignatures: ['autoincrement()'],
      },
    ],
    [
      'uuid',
      {
        signature: {
          positional: [
            { key: 'version', type: optional(oneOf(num(4), num(7))) },
          ],
        },
        lower: ({ call }) =>
          generator(call.args['version'] === 7 ? 'uuidv7' : 'uuidv4'),
        usageSignatures: ['uuid()', 'uuid(4)', 'uuid(7)'],
      },
    ],
    [
      'ulid',
      {
        signature: {},
        lower: () => generator('ulid'),
        usageSignatures: ['ulid()'],
      },
    ],
    [
      'cuid',
      {
        signature: { positional: [{ key: 'version', type: num(2) }] },
        lower: () => generator('cuid2'),
        usageSignatures: ['cuid(2)'],
      },
    ],
    [
      'nanoid',
      {
        signature: {
          positional: [
            { key: 'size', type: optional(int({ min: 2, max: 255 })) },
          ],
        },
        lower: ({ call }) =>
          generator(
            'nanoid',
            typeof call.args['size'] === 'number'
              ? { size: call.args['size'] }
              : undefined,
          ),
        usageSignatures: ['nanoid()', 'nanoid(21)'],
      },
    ],
    [
      'now',
      {
        signature: {},
        lower: ({ context }) => ({
          ok: false,
          diagnostic: {
            code: 'YDB.DEFAULT_FUNCTION_UNSUPPORTED',
            sourceId: context.sourceId,
            message:
              'YDB supports literal column defaults only. Supply createdAt explicitly; database now() defaults cannot be represented faithfully.',
          },
        }),
      },
    ],
  ]),
  generatorDescriptors: builtinGeneratorRegistryMetadata.map(({ id }) => ({
    id,
    applicableCodecIds: ['ydb/utf8@1'],
  })),
};
