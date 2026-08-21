import { z } from 'zod';
import { paymentMethodSchema } from '../codes/payment-method';
import {
  PaymentVerificationStatus,
  isPaymentVerificationStatus,
  paymentVerificationStatusSchema,
} from '../codes/payment-verification-status';
import { money } from '../money/money';
import {
  auditFieldsSchema,
  idSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  optionalText,
  requiredText,
} from './common';

/**
 * Money received from the client for a trip.
 *
 * THE MIRROR OF AN `Allowance`, and modelled the same way for the same reason.
 * A trip is rarely settled in one movement: a downpayment on booking, the
 * balance thirty days after delivery, sometimes a short payment made up later.
 * Each one is its own row with its own date, method and paper trail, because
 * each one is a separate movement of cash somebody has to be able to point at.
 * There is deliberately no editable `amountPaid` on the shipment for a second
 * receipt to overwrite, which would leave the first with no record it happened.
 *
 * NOT REVENUE, and this is the distinction the record exists to keep. Revenue
 * was recognised when the trip ran — the freight, the rebilled expenses, the
 * extra charges — and it is what `GrossProfit` counts. A payment is the
 * COLLECTION of that revenue. Counting it as income would book the same peso
 * twice and would make a trip's profit depend on how fast the client's accounts
 * payable department moves.
 *
 * NO PAYER FIELD, and its absence is deliberate. The shipment already names the
 * client it was booked for and the broker it was booked through, and a payment
 * is against the trip. A nullable payer would be a second place the same fact
 * is recorded, free to disagree with the first; a client settling somebody
 * else's invoice is what `remarks` is for.
 */
export const clientPaymentSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  /** Denormalised for the cross-trip queue, which lists trips it never loads. */
  shipmentNumber: z.string().nullable(),
  clientName: z.string().nullable(),

  amount: z.string(),
  receivedAt: z.string(),

  paymentMethod: paymentMethodSchema,

  /**
   * The check number, the transfer reference, the official receipt number.
   *
   * OPTIONAL FOR EVERY METHOD AND NEVER UNIQUE, exactly as on a release. One
   * check legitimately settles two trips and carries one number on both, so a
   * unique index would refuse the truth. Repetition is reported instead — see
   * `referenceNumberIsDuplicated`.
   */
  referenceNumber: z.string().nullable(),

  /**
   * This reference appears on another live payment, anywhere in the system.
   *
   * A WARNING, NEVER A REFUSAL, and the same design as the allowance's. The
   * legitimate case is one check covering several trips; the far more common
   * one is the same deposit slip entered twice, which nothing else catches
   * because it usually lands on two different shipments. Stating it lets the
   * person holding the slip decide which of the two they have.
   *
   * DERIVED PER REQUEST, not stored — the answer changes when another payment
   * is recorded or removed. Answered only by the summary; `false` elsewhere
   * means "not checked", the same convention the allowance uses.
   */
  referenceNumberIsDuplicated: z.boolean().default(false),

  /** Deposit slip, check image, remittance advice. The same table and pipeline
   * as a liquidation receipt, because it is the same kind of object. */
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),

  remarks: z.string().nullable(),

  // --- has accounting checked it? -----------------------------------------
  /**
   * Whether accounting has matched this against the bank. See
   * `PaymentVerificationStatus` for what each state means and, in particular,
   * for why an UNVERIFIED payment still counts as collected and a RETURNED one
   * does not.
   */
  verificationStatus: paymentVerificationStatusSchema,

  /**
   * Who performed the verification, and when. Both null while UNVERIFIED and
   * both stamped together the moment accounting answers.
   *
   * NAMES WHO LOOKED, not that it succeeded — a RETURNED row carries these too,
   * because "which accountant could not find this" is exactly who the
   * person who recorded it needs to go and talk to.
   */
  verifiedBy: z.string().nullable(),
  verifiedByName: z.string().nullable(),
  verifiedAt: z.string().nullable(),

  /** Why accounting could not match it. Required on a return, absent otherwise. */
  verificationNote: z.string().nullable(),

  /** Who typed the payment in — the dispatch manager, usually. */
  recordedByName: z.string().nullable(),
});

export type ClientPayment = z.infer<typeof clientPaymentSchema>;

/**
 * Accounting confirming a payment against the bank.
 *
 * NO PAYLOAD AT ALL, and that is the point rather than an omission. Verifying
 * is a statement that the row as it stands matches the statement line — if some
 * detail is wrong, the honest answer is a query naming it, or a correction made
 * by the person who may correct it. An amount on this payload would let
 * "verified" sit beside a figure that was quietly changed at the moment of
 * verifying, which is the same trap `approveAllowanceRequestSchema` refuses.
 */
export const verifyClientPaymentSchema = z.object({});
export type VerifyClientPaymentInput = z.infer<typeof verifyClientPaymentSchema>;

/**
 * Accounting handing one back for correction. The reason is the entire content
 * of the message going to whoever recorded it — the same shape, and the same
 * argument, as returning a liquidation to the crew.
 */
export const returnClientPaymentSchema = z.object({
  reason: requiredText(400),
});

export type ReturnClientPaymentInput = z.infer<typeof returnClientPaymentSchema>;

/**
 * The cross-trip queue.
 *
 * Defaults to UNVERIFIED because that is the only state anybody is waiting on;
 * the rest are read on the trip they belong to. The same shape, and the same
 * argument, as `allowanceRequestListQuerySchema`.
 */
export const clientPaymentListQuerySchema = z.object({
  verificationStatus: z.coerce
    .number()
    .int()
    .refine(isPaymentVerificationStatus, 'unknown payment verification status')
    .default(PaymentVerificationStatus.UNVERIFIED),
});

export type ClientPaymentListQuery = z.infer<typeof clientPaymentListQuerySchema>;

/**
 * A received amount is strictly positive.
 *
 * A REFUND IS NOT A NEGATIVE PAYMENT, and a dishonoured check is not either.
 * Both are the removal of a receipt that turns out not to have happened, which
 * the soft delete already records with who did it and when — the same call as
 * `releasedMoneySchema`, and the reason neither table carries a sign. A
 * negative row would also make "how much has this client paid" a figure that
 * depends on which rows you decided to count.
 */
export const receivedMoneySchema = moneyStringSchema.refine(
  (value) => Number(value) > 0,
  'must be greater than zero',
);

export const recordClientPaymentSchema = z.object({
  amount: receivedMoneySchema,

  /** Defaults to now, so a payment can be recorded once the bank confirms it. */
  receivedAt: isoDateTimeSchema.nullish().transform((value) => value ?? null),

  paymentMethod: paymentMethodSchema,

  /**
   * Optional for every method. Cash collected at the client's office has no
   * reference, and requiring one only produces an invented one.
   */
  referenceNumber: optionalText(80),
  receiptId: idSchema.nullish().transform((value) => value ?? null),

  remarks: optionalText(400),
});

export type RecordClientPaymentInput = z.infer<typeof recordClientPaymentSchema>;

/** Corrections to a payment already recorded. */
export const updateClientPaymentSchema = recordClientPaymentSchema.partial();
export type UpdateClientPaymentInput = z.infer<typeof updateClientPaymentSchema>;

/**
 * Where a trip stands against what it was billed.
 *
 * DERIVED FROM THE ROWS, never stored, for the same reason as every other
 * status this system computes: a stored `PAID` would go stale the moment a late
 * charge was added, and it would go stale silently.
 */
export const PAYMENT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID', 'OVERPAID'] as const;

export const paymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const PAYMENT_STATUS_LABELS: Readonly<Record<PaymentStatus, string>> = {
  UNPAID: 'Unpaid',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid in full',
  OVERPAID: 'Overpaid',
};

/**
 * A STRING UNION RATHER THAN A CODE SET, which is the rule this codebase
 * already follows for `RemovalOutcome`: a code set is a SMALLINT with a CHECK
 * and a column comment behind it, and this value is never written to a column.
 * Declaring one would put a number in the catalog that no row can ever carry.
 *
 * NOTHING HAS COME IN IS CHECKED FIRST, and the order is load-bearing. A trip
 * with nothing billed yet has a zero balance, and reporting that as "paid in
 * full" would tell accounting a client has settled when they have not been
 * asked for anything. Reporting "unpaid" beside a zero balance is at worst
 * uninformative; the other way round is wrong.
 *
 * OVERPAID IS REPORTED, NOT REFUSED. It is a real thing that happens — one
 * check applied to the wrong trip, a client rounding up, a charge removed
 * after the invoice went out — and the amount due moves on its own as charges
 * are recorded, so a payment that was exact on Tuesday can be an overpayment on
 * Wednesday without anybody touching it.
 */
export function paymentStatusOf(amountDue: string, amountPaid: string): PaymentStatus {
  const due = money(amountDue).intValue;
  const paid = money(amountPaid).intValue;

  if (paid === 0) return 'UNPAID';
  if (paid > due) return 'OVERPAID';
  if (paid === due) return 'PAID';

  return 'PARTIALLY_PAID';
}

/**
 * Every payment on a trip, what it was billed, and what is still outstanding.
 *
 * THE BREAKDOWN TRAVELS WITH THE ANSWER, the same decision `GrossProfit` makes:
 * `amountDue` is three figures added together, and a single number nobody can
 * decompose is a number nobody can argue with when a client disputes it.
 */
export const clientPaymentSummarySchema = z.object({
  shipmentId: z.string(),

  // --- what the client owes, and out of what ------------------------------
  /**
   * The freight after the broker's cut, plus everything rebilled to the client.
   * The same figure `GrossProfit.revenue` reports, computed in one place so an
   * invoice and a P&L cannot disagree about what the trip was worth.
   */
  amountDue: z.string(),
  netRate: z.string(),
  billableExpenses: z.string(),
  additionalCharges: z.string(),

  /**
   * A charge can still be added to this trip, so what is owed can still grow.
   *
   * Not a caveat about the payments — those are facts — but about the figure
   * they are measured against. Chasing a balance that is still moving is how a
   * client is invoiced twice, and the screen says so rather than leaving
   * accounting to infer it from the trip's status.
   */
  amountDueIsProvisional: z.boolean(),

  // --- what has come in ----------------------------------------------------
  /**
   * Everything recorded and not queried — UNVERIFIED and VERIFIED together.
   *
   * AN UNVERIFIED PAYMENT COUNTS. Money a client demonstrably sent does not
   * become less sent while it waits for accounting to tick it, and a
   * receivables figure that lagged their queue would have somebody chasing a
   * client who had already paid. `amountVerified` below says how much of this
   * has actually been confirmed, so nobody reads one as the other.
   *
   * A RETURNED PAYMENT DOES NOT. Unverified means nobody has looked; returned
   * means somebody looked and stated they could not match it, and counting a
   * disputed figure is how a trip reads as settled on a receipt nobody can
   * find. It rejoins this total the moment the record is corrected.
   */
  amountPaid: z.string(),

  /** The subset accounting has matched against the bank. */
  amountVerified: z.string(),

  /** Recorded, then returned for correction — excluded from `amountPaid`. */
  amountReturned: z.string(),

  /** How many payments are sitting in accounting's queue. */
  awaitingVerification: z.number().int().nonnegative(),

  paymentCount: z.number().int().nonnegative(),

  /** Due minus paid. NEGATIVE when the client has overpaid, which is a real
   * state and is reported rather than clamped to zero. */
  balance: z.string(),

  status: paymentStatusSchema,

  payments: z.array(clientPaymentSchema),
});

export type ClientPaymentSummary = z.infer<typeof clientPaymentSummarySchema>;
