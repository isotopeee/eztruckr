import { defineCodeSet } from './code-set';

/**
 * How cash physically moved. Stored as `allowance.disbursementMode` and
 * `settlement.disbursementMode` SMALLINT.
 *
 * The same set governs both directions on purpose. Money leaving the company
 * for the crew (an allowance release) and money coming back (a settlement) are
 * documented identically, so a reviewer reconciling a trip reads one vocabulary
 * rather than two, and a bank statement line can be matched from either end.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const DisbursementMode = {
  CASH: 1,
  BANK_TRANSFER: 2,
  EWALLET: 3,
} as const;

export type DisbursementMode = (typeof DisbursementMode)[keyof typeof DisbursementMode];

const meta = defineCodeSet('DisbursementMode', DisbursementMode);

export const DISBURSEMENT_MODE_CODES = meta.codes;
export const isDisbursementMode = meta.isValid;
export const disbursementModeSchema = meta.schema;

export const DISBURSEMENT_MODE_LABELS: Readonly<Record<DisbursementMode, string>> = {
  [DisbursementMode.CASH]: 'Cash',
  [DisbursementMode.BANK_TRANSFER]: 'Bank transfer',
  [DisbursementMode.EWALLET]: 'E-wallet',
};

/**
 * Whether a reference number is worth prompting for.
 *
 * A prompt, never a requirement. Cash handed over in the yard has no reference
 * and no attachment, and a system that insisted on one would be answered with
 * an invented one — which is worse than an empty column, because it looks like
 * evidence. The column stays optional for every mode; this only decides whether
 * the form asks.
 */
export function expectsReferenceNumber(mode: DisbursementMode): boolean {
  return mode !== DisbursementMode.CASH;
}
