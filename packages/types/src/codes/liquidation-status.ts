import { defineCodeSet } from './code-set';

/**
 * Liquidation lifecycle. Stored as `liquidation.status` SMALLINT.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const LiquidationStatus = {
  SUBMITTED: 1,
  APPROVED: 2,
  FINALIZED: 3,
} as const;

export type LiquidationStatus = (typeof LiquidationStatus)[keyof typeof LiquidationStatus];

const meta = defineCodeSet('LiquidationStatus', LiquidationStatus);

export const LIQUIDATION_STATUS_CODES = meta.codes;
export const isLiquidationStatus = meta.isValid;
export const liquidationStatusSchema = meta.schema;

export const LIQUIDATION_STATUS_LABELS: Readonly<Record<LiquidationStatus, string>> = {
  [LiquidationStatus.SUBMITTED]: 'Submitted',
  [LiquidationStatus.APPROVED]: 'Approved',
  [LiquidationStatus.FINALIZED]: 'Finalized',
};

/** Explicit progression; never inferred from the numeric value. */
export const LIQUIDATION_STATUS_SEQUENCE: readonly LiquidationStatus[] = [
  LiquidationStatus.SUBMITTED,
  LiquidationStatus.APPROVED,
  LiquidationStatus.FINALIZED,
];

export function liquidationStatusRank(status: LiquidationStatus): number {
  return LIQUIDATION_STATUS_SEQUENCE.indexOf(status);
}

export function liquidationStatusAtLeast(
  candidate: LiquidationStatus,
  reference: LiquidationStatus,
): boolean {
  return liquidationStatusRank(candidate) >= liquidationStatusRank(reference);
}
