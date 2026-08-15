import { z } from 'zod';
import { liquidationHistoryActionSchema } from '../codes/liquidation-history-action';
import { liquidationStatusSchema, LiquidationStatus } from '../codes/liquidation-status';
import { ShipmentStatus } from '../codes/shipment-status';
import {
  auditFieldsSchema,
  idSchema,
  isoDateTimeSchema,
  optionalText,
  requiredText,
} from './common';
import { releasedMoneySchema } from './allowance';

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export const liquidationLineSchema = auditFieldsSchema.extend({
  id: z.string(),
  liquidationId: z.string(),
  expenseCategoryId: z.string(),
  expenseCategoryName: z.string().nullable(),
  description: z.string().nullable(),
  amount: z.string(),
  spentAt: z.string(),
  payeeId: z.string().nullable(),
  payeeName: z.string().nullable(),
  /**
   * The rule that applied to THIS line, frozen when it was written — not the
   * category's current setting. A line recorded when tolls needed no payee
   * keeps saying so after somebody flips the category.
   */
  payeeRequired: z.boolean(),
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),
  /** From the category: whether this line is expected to have one attached. */
  requiresReceipt: z.boolean(),
});

export type LiquidationLine = z.infer<typeof liquidationLineSchema>;

export const createLiquidationLineSchema = z.object({
  expenseCategoryId: idSchema,
  description: optionalText(200),
  amount: releasedMoneySchema,
  spentAt: isoDateTimeSchema,
  /**
   * Who the crew paid.
   *
   * Optional HERE because whether it is required depends on the expense
   * category, which this schema cannot see. The service resolves the category
   * and refuses a missing payee when that category demands one; the database
   * backs it up with `liquidation_line_payee_required`. Zod is the wrong layer
   * for a rule whose input is another table.
   */
  payeeId: idSchema.nullish().transform((value) => value ?? null),
  receiptId: idSchema.nullish().transform((value) => value ?? null),
});

export type CreateLiquidationLineInput = z.infer<typeof createLiquidationLineSchema>;

export const updateLiquidationLineSchema = createLiquidationLineSchema.partial();
export type UpdateLiquidationLineInput = z.infer<typeof updateLiquidationLineSchema>;

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const liquidationHistoryEntrySchema = z.object({
  id: z.string(),
  action: liquidationHistoryActionSchema,
  actorId: z.string(),
  actorName: z.string().nullable(),
  occurredAt: z.string(),
  /** Present on a return, absent on a submission. */
  reason: z.string().nullable(),
});

export type LiquidationHistoryEntry = z.infer<typeof liquidationHistoryEntrySchema>;

// ---------------------------------------------------------------------------
// The liquidation
// ---------------------------------------------------------------------------

/**
 * ONE CUSTODIAN'S ACCOUNT of one trip's cash. There may be several per trip.
 *
 * It was one per shipment until the custodian existed, and that single row was
 * blending two people's money: with a driver holding ₱10,000 and a helper
 * holding ₱3,000, one `variance` could say what the TRIP was short by and never
 * which of them owed it. Splitting it is what lets the settlement — and the
 * outstanding-allowances alert built on it — name a person.
 */
export const liquidationSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  shipmentNumber: z.string().nullable(),

  /**
   * The staff member answerable for accounting for this cash.
   *
   * Null on the liquidation created with the shipment, because nobody has been
   * assigned to drive it yet. NOT the same as an allowance's recipient: a
   * helper can be handed ferry money the driver remains answerable for.
   *
   * NOT NECESSARILY ON THE TRUCK, either. A dispatch manager holds a trip's
   * float without driving or helping, which is why this points at `staff`
   * rather than at one of the shipment's crew slots.
   */
  custodianId: z.string().nullable(),
  custodianName: z.string().nullable(),

  status: liquidationStatusSchema,

  /** Sum of the releases booked against THIS account, frozen at approval. */
  totalAllowance: z.string(),
  totalLiquidated: z.string(),
  /** totalAllowance - totalLiquidated. Positive = crew return cash. */
  variance: z.string(),

  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedByName: z.string().nullable(),
  remarks: z.string().nullable(),

  /**
   * The voucher or document number this account was settled under.
   *
   * NOT an identifier this system issues, and never unique: it is what somebody
   * wrote on a piece of paper, and two documents genuinely carrying the same
   * reference is a fact to record rather than one to refuse.
   */
  referenceNumber: z.string().nullable(),

  lines: z.array(liquidationLineSchema),
  history: z.array(liquidationHistoryEntrySchema),

  /**
   * What this liquidation contributes to the P&L right now.
   *
   * Derived from the status, never posted: it equals `totalLiquidated` at
   * APPROVED and is zero at every other status. A liquidation sitting with the
   * crew, or returned to them, contributes nothing — and because this is
   * derived, a return-and-resubmit cycle cannot post a second set of costs
   * however many times it goes round.
   */
  recognisedCost: z.string(),

  /**
   * Sent back to the crew at least once. This is what a `RETURNED` status would
   * have said, answered from the history, which also says when and why.
   */
  wasReturned: z.boolean(),
  latestReturnReason: z.string().nullable(),

  /** Lines and totals may still change — false once approved. */
  isEditable: z.boolean(),
});

export type Liquidation = z.infer<typeof liquidationSchema>;

/**
 * Opening a second account on a trip, for a second cash holder.
 *
 * The custodian is REQUIRED here, unlike on the column. The nullable column
 * exists for exactly one row — the one created automatically with the shipment,
 * before anybody is assigned — and a second account created by hand with nobody
 * answerable for it would be indistinguishable from that one, which is the
 * ambiguity the partial unique index refuses anyway.
 */
export const createLiquidationSchema = z.object({
  custodianId: idSchema,
});

export type CreateLiquidationInput = z.infer<typeof createLiquidationSchema>;

/** Naming, or renaming, who is answerable. Null hands it back to nobody. */
export const setCustodianSchema = z.object({
  custodianId: idSchema.nullish().transform((value) => value ?? null),
});

export type SetCustodianInput = z.infer<typeof setCustodianSchema>;

/**
 * Recording the voucher number an account was settled under.
 *
 * ITS OWN CALL rather than a field on `submit`, because the two are not the
 * same event. A reference arrives when the paperwork does — which may be before
 * the crew submit, after accounting have looked at it, or as a correction to a
 * digit somebody transposed — and folding it into the submission would mean the
 * only chance to state it was the one moment a person may not have it. It stays
 * open until approval, like everything else on the account.
 */
export const setLiquidationReferenceSchema = z.object({
  referenceNumber: optionalText(80),
});

export type SetLiquidationReferenceInput = z.infer<typeof setLiquidationReferenceSchema>;

// ---------------------------------------------------------------------------
// The four moves
// ---------------------------------------------------------------------------

export const submitLiquidationSchema = z.object({
  remarks: optionalText(400),
});

export type SubmitLiquidationInput = z.infer<typeof submitLiquidationSchema>;

/**
 * Returning work to the crew. The reason is required and is the entire point:
 * a return with no reason is the crew being told to try again with no idea what
 * was wrong. It lands in `LiquidationHistory` and the portal shows the latest.
 */
export const returnLiquidationSchema = z.object({
  reason: requiredText(400),
});

export type ReturnLiquidationInput = z.infer<typeof returnLiquidationSchema>;

export const approveLiquidationSchema = z.object({
  remarks: optionalText(400),
});

export type ApproveLiquidationInput = z.infer<typeof approveLiquidationSchema>;

/**
 * Reversing an approval. Approval is the lock, so unlocking it is an explicit,
 * reasoned act written to the audit trail — not a status edit.
 */
export const reverseLiquidationSchema = z.object({
  reason: requiredText(400),
});

export type ReverseLiquidationInput = z.infer<typeof reverseLiquidationSchema>;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/**
 * The cross-shipment view: an accounting queue, and the crew's own list.
 *
 * `returnedOnly` is the dashboard's "returned for correction" filter. It is a
 * flag rather than a status value because there IS no returned status — see the
 * code set — and expressing it as `status=PENDING&hasHistory=true` in every
 * caller is how the definition drifts.
 */
export const liquidationListQuerySchema = z.object({
  status: z.coerce
    .number()
    .int()
    .refine(
      (value) => Object.values(LiquidationStatus).includes(value as LiquidationStatus),
      'unknown liquidation status',
    )
    .optional(),
  returnedOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((value) => value === true || value === 'true'),
});

export type LiquidationListQuery = z.infer<typeof liquidationListQuerySchema>;

// ---------------------------------------------------------------------------
// The predicate both sides share
// ---------------------------------------------------------------------------

/**
 * What a shipment's status should be, given the two facts that decide it.
 *
 * A shipment is LIQUIDATED when EVERY liquidation on it is approved AND
 * commissions have been computed. Neither half owns the transition: whichever
 * lands second applies it. Phase 4 wrote the commission half; this function is
 * the whole rule, called from both sides, so the two can never drift into
 * disagreeing about what "liquidated" means.
 *
 * The first fact is `allLiquidationsApproved`, not "an approved liquidation
 * exists", and the rename is the point. A trip can now carry one account per
 * cash holder, and "somebody has squared up" is a much weaker claim than "the
 * trip is accounted for" — the old wording would have marked a trip liquidated
 * while a second custodian still held cash nobody had counted.
 *
 * It also runs backwards, and that is deliberate. Reversing an approval retracts
 * one of the two facts, and a shipment left sitting at LIQUIDATED with no
 * approved liquidation would sail through the close guard on the strength of a
 * status that is no longer true. This is the one backward move in the shipment
 * workflow, it is derived rather than requested, and it stops at CLOSED — where
 * the money has been settled and reversal is refused outright.
 *
 * Returns null when nothing should change.
 */
export function shipmentStatusAfterLiquidationMilestone(
  current: ShipmentStatus,
  facts: { allLiquidationsApproved: boolean; commissionsComputed: boolean },
): ShipmentStatus | null {
  const earned = facts.allLiquidationsApproved && facts.commissionsComputed;

  if (current === ShipmentStatus.PENDING_LIQUIDATION) {
    return earned ? ShipmentStatus.LIQUIDATED : null;
  }

  if (current === ShipmentStatus.LIQUIDATED) {
    return earned ? null : ShipmentStatus.PENDING_LIQUIDATION;
  }

  return null;
}

/**
 * "Returned for correction" as the dashboard means it: with the crew, and not
 * for the first time.
 *
 * Declared here so the API filter and any badge agree, rather than each
 * re-deriving it from a status that deliberately does not record it.
 */
export function wasReturnedForCorrection(status: LiquidationStatus, historyCount: number): boolean {
  return status === LiquidationStatus.PENDING && historyCount > 0;
}
