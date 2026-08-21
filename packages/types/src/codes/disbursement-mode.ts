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

/**
 * Whether a release by this mode must carry proof — but only where somebody
 * else asked for the money.
 *
 * A BANK TRANSFER AND AN E-WALLET PAYMENT BOTH PRODUCE A DOCUMENT as a side
 * effect of happening at all: the app issues a confirmation, the bank issues a
 * slip. There is nothing to invent, so requiring one costs the person releasing
 * the cash a screenshot they already have. Cash handed over in the yard
 * produces nothing, and demanding an attachment there is how a photograph of a
 * blank page ends up in the bucket looking like evidence.
 *
 * THIS IS NOT `expectsReferenceNumber` WITH A HARDER EDGE, even though the two
 * agree on which modes they name. A reference number is TYPED, so requiring one
 * yields "N/A"; a receipt is UPLOADED, so requiring one yields either the
 * document or a refusal. That difference is why one of these is a prompt and
 * the other is a rule.
 *
 * WHERE IT APPLIES is narrower than every release: it governs approving an
 * ALLOWANCE REQUEST, where accounting is releasing cash at a dispatch manager's
 * asking. Accounting recording its own release stays as it was — the requirement
 * exists because the person who asked and the person who paid are different
 * people, which is precisely when a document is what connects them.
 */
export function expectsProofOfRelease(mode: DisbursementMode): boolean {
  return mode !== DisbursementMode.CASH;
}
