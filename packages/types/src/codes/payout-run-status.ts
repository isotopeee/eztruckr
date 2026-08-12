import { defineCodeSet } from './code-set';

/**
 * Payout run lifecycle. Stored as `payout_run.status` SMALLINT.
 *
 * Not one of the code sets named in the brief — it is required because "a
 * commission in a PAID run can never be paid again" is meaningless without a
 * run lifecycle. PAID is terminal, enforced by a database trigger.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const PayoutRunStatus = {
  DRAFT: 1,
  APPROVED: 2,
  PAID: 3,
  VOIDED: 4,
} as const;

export type PayoutRunStatus = (typeof PayoutRunStatus)[keyof typeof PayoutRunStatus];

const meta = defineCodeSet('PayoutRunStatus', PayoutRunStatus);

export const PAYOUT_RUN_STATUS_CODES = meta.codes;
export const isPayoutRunStatus = meta.isValid;
export const payoutRunStatusSchema = meta.schema;

export const PAYOUT_RUN_STATUS_LABELS: Readonly<Record<PayoutRunStatus, string>> = {
  [PayoutRunStatus.DRAFT]: 'Draft',
  [PayoutRunStatus.APPROVED]: 'Approved',
  [PayoutRunStatus.PAID]: 'Paid',
  [PayoutRunStatus.VOIDED]: 'Voided',
};

/**
 * VOIDED is not a later stage of the workflow, it is an exit from it, so this
 * sequence deliberately excludes it. Compare with the named constants.
 */
export const PAYOUT_RUN_STATUS_SEQUENCE: readonly PayoutRunStatus[] = [
  PayoutRunStatus.DRAFT,
  PayoutRunStatus.APPROVED,
  PayoutRunStatus.PAID,
];

/** PAID is terminal — no transition out of it exists, including to VOIDED. */
export function isTerminalPayoutRunStatus(status: PayoutRunStatus): boolean {
  return status === PayoutRunStatus.PAID || status === PayoutRunStatus.VOIDED;
}
