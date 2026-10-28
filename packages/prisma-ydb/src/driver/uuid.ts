import { Uuid as NativeUuid } from '@ydbjs/value/primitive';

/** UUID identity does not depend on a particular version or variant. */
export function uuidText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new TypeError('Uuid requires a hyphenated UUID string');
  return value.toLowerCase();
}

/** Native Uuid parameter; preserves the SDK's 128-bit wire representation. */
export class UuidValue extends NativeUuid {
  constructor(value: string) {
    super(uuidText(value));
  }
}
