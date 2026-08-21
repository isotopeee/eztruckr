import { defineCodeSet } from './code-set';

/**
 * How a client's payment physically reached the company. Stored as
 * `client_payment.paymentMethod` SMALLINT.
 *
 * A SEPARATE SET FROM `DisbursementMode`, DELIBERATELY, and the first three
 * codes agreeing is a convenience for whoever reads both tables side by side —
 * not an invitation to substitute one for the other. `DisbursementMode`
 * documents the two directions of TRIP CASH: money leaving for the crew, and
 * the change coming back. This is a third direction with a different
 * counterparty and, decisively, a different vocabulary.
 *
 * THE VOCABULARY IS WHY. A Philippine corporate client settles a hauling
 * invoice by check more often than by anything else, and a check is not a
 * bank transfer: it carries a check number rather than a transaction
 * reference, it is dated, and it can be dishonoured after it was recorded.
 * Folding it into BANK_TRANSFER would mean a check number typed into a field
 * labelled "transaction reference" — invented data that reads like evidence,
 * which is the failure this codebase keeps refusing.
 *
 * Widening `DisbursementMode` with a fourth code instead was the alternative,
 * and it was rejected: it would have said a crew allowance may be released by
 * check, which is not true here, and it would have moved two live constraints
 * to say something about client money.
 *
 * NOTE THE NAME COLLIDES WITH SQL's `CHECK` keyword, which this schema uses
 * heavily. Anywhere `CHECK` appears against `client_payment` — the code, the
 * column comment, the migration — it means the payment instrument; the
 * constraint is always spelled out as `..._code_valid` or similar beside it.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const PaymentMethod = {
  CASH: 1,
  BANK_TRANSFER: 2,
  EWALLET: 3,
  CHECK: 4,
} as const;

export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];

const meta = defineCodeSet('PaymentMethod', PaymentMethod);

export const PAYMENT_METHOD_CODES = meta.codes;
export const isPaymentMethod = meta.isValid;
export const paymentMethodSchema = meta.schema;

export const PAYMENT_METHOD_LABELS: Readonly<Record<PaymentMethod, string>> = {
  [PaymentMethod.CASH]: 'Cash',
  [PaymentMethod.BANK_TRANSFER]: 'Bank transfer',
  [PaymentMethod.EWALLET]: 'E-wallet',
  [PaymentMethod.CHECK]: 'Check',
};

/**
 * Whether a reference number is worth prompting for.
 *
 * A PROMPT, NEVER A REQUIREMENT — the same rule, and the same argument, as
 * `expectsReferenceNumber` on the disbursement side. Cash collected from a
 * client's office has no reference, and a mandatory field is answered with
 * "N/A", which looks like evidence and is not. The column stays optional for
 * every method; this only decides whether the form asks.
 *
 * Check is included because the check number is the reference, and it is the
 * one number a client will quote when they ring to ask whether their payment
 * landed.
 */
export function expectsPaymentReference(method: PaymentMethod): boolean {
  return method !== PaymentMethod.CASH;
}
