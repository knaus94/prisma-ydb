import type { Contract } from '@prisma/orm-framework/contract/types';
import type { SqlStorage } from '@prisma/orm-family-sql/contract/types';
import { ydbContractSerializer } from '../control/contract.js';

/** Hydrate and validate generated contract JSON without constructing a client. */
export function ydbContract<
  C extends Contract<SqlStorage> = Contract<SqlStorage>,
>(contractJson: unknown): C {
  return ydbContractSerializer.deserializeContract<C>(contractJson);
}
