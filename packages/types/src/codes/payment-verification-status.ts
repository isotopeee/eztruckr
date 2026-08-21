import { defineCodeSet } from './code-set';

/**
 * Whether accounting has checked a recorded payment against the bank. Stored as
 * `client_payment.verificationStatus` SMALLINT.
 *
 * WHY THE STATE EXISTS. A dispatch manager records what a client paid — they
 * moved the freight and are routinely the first to hear the money landed.
 * Accounting holds the bank statement. Those are two people, and before this
 * the second one had no way to say "I found it" or "I cannot find it" inside
 * the system. A payment
 * nobody had matched looked exactly like a payment somebody had.
 *
 * THREE STATES:
 *
 *   UNVERIFIED  recorded and waiting on accounting. The money is COUNTED — see
 *               below — but nobody has matched it to a statement line yet.
 *   VERIFIED    accounting found it. The figure is confirmed and the row is
 *               closed to the person who recorded it.
 *   RETURNED    accounting could not match it, and said why. It goes back to
 *               whoever recorded it for correction; fixing it returns the row
 *               to UNVERIFIED and back into the queue. The same verb, and the
 *               same required reason, as returning a liquidation to the crew.
 *
 * AN UNVERIFIED PAYMENT STILL COUNTS toward what the trip has collected, and
 * that is deliberate — the same call `GrossProfit` makes about a running
 * liquidation. Money a client demonstrably sent does not become less sent while
 * it waits for a tick, and a receivables figure that lagged accounting's queue
 * would have people chasing clients who had already paid. What the payment
 * summary reports alongside it is how much of that total has been confirmed.
 *
 * A RETURNED PAYMENT DOES NOT COUNT, and this is the one asymmetry. Unverified
 * means "nobody has looked yet"; returned means somebody looked and stated they
 * could not match it. Counting a figure that has been explicitly disputed is
 * how a trip reads as settled on a receipt nobody can find. It comes back the
 * moment the record is corrected.
 *
 * THERE IS NO `REJECTED`. A return is about the RECORD, not the money — the
 * client may well have paid, and the entry may simply have the wrong trip or
 * the wrong amount on it. A payment that genuinely never arrived is reversed,
 * which is the row's own removal.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const PaymentVerificationStatus = {
  UNVERIFIED: 1,
  VERIFIED: 2,
  RETURNED: 3,
} as const;

export type PaymentVerificationStatus =
  (typeof PaymentVerificationStatus)[keyof typeof PaymentVerificationStatus];

const meta = defineCodeSet('PaymentVerificationStatus', PaymentVerificationStatus);

export const PAYMENT_VERIFICATION_STATUS_CODES = meta.codes;
export const isPaymentVerificationStatus = meta.isValid;
export const paymentVerificationStatusSchema = meta.schema;

export const PAYMENT_VERIFICATION_STATUS_LABELS: Readonly<
  Record<PaymentVerificationStatus, string>
> = {
  [PaymentVerificationStatus.UNVERIFIED]: 'Awaiting accounting',
  [PaymentVerificationStatus.VERIFIED]: 'Verified',
  [PaymentVerificationStatus.RETURNED]: 'Returned for correction',
};

/**
 * Whether this payment's amount is counted as collected.
 *
 * Asked instead of comparing against RETURNED directly, so a fourth code
 * appended later cannot be treated as counting by half the call sites and not
 * by the other half — the same reasoning as `isAllowanceRequestDecided`.
 */
export function countsAsCollected(status: PaymentVerificationStatus): boolean {
  return status !== PaymentVerificationStatus.RETURNED;
}

/**
 * Whether the decision has to state why.
 *
 * A return with no reason is whoever recorded it being told to look again with
 * no idea what to look for — the same argument that makes a liquidation's
 * return reason and an allowance request's decline reason mandatory. Backed by `client_payment_verification_matches_status`, so it is a
 * property of the row rather than of the service that wrote it.
 *
 * A verification carries no note at all: it matched, and an empty box beside
 * every confirmed payment would only dilute the one that says something.
 */
export function requiresVerificationNote(status: PaymentVerificationStatus): boolean {
  return status === PaymentVerificationStatus.RETURNED;
}
