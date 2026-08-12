import { defineCodeSet } from './code-set';

/**
 * Direction of a manual payout adjustment. Stored as
 * `adjustment.direction` SMALLINT.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const AdjustmentDirection = {
  INCREASE: 1,
  DECREASE: 2,
} as const;

export type AdjustmentDirection = (typeof AdjustmentDirection)[keyof typeof AdjustmentDirection];

const meta = defineCodeSet('AdjustmentDirection', AdjustmentDirection);

export const ADJUSTMENT_DIRECTION_CODES = meta.codes;
export const isAdjustmentDirection = meta.isValid;
export const adjustmentDirectionSchema = meta.schema;

export const ADJUSTMENT_DIRECTION_LABELS: Readonly<Record<AdjustmentDirection, string>> = {
  [AdjustmentDirection.INCREASE]: 'Increase',
  [AdjustmentDirection.DECREASE]: 'Decrease',
};
