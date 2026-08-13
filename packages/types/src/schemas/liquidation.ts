import { z } from 'zod';
import { liquidationHistoryActionSchema } from '../codes/liquidation-history-action';
import { liquidationStatusSchema, LiquidationStatus } from '../codes/liquidation-status';
import { ShipmentStatus } from '../codes/shipment-status';
import {
  auditFieldsSchema,
  cuidSchema,
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
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),
  /** From the category: whether this line is expected to have one attached. */
  requiresReceipt: z.boolean(),
});

export type LiquidationLine = z.infer<typeof liquidationLineSchema>;

export const createLiquidationLineSchema = z.object({
  expenseCategoryId: cuidSchema,
  description: optionalText(200),
  amount: releasedMoneySchema,
  spentAt: isoDateTimeSchema,
  receiptId: cuidSchema.nullish().transform((value) => value ?? null),
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

export const liquidationSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  shipmentNumber: z.string().nullable(),

  status: liquidationStatusSchema,

  /** Sum of every allowance released on the trip, frozen at approval. */
  totalAllowance: z.string(),
  totalLiquidated: z.string(),
  /** totalAllowance - totalLiquidated. Positive = crew return cash. */
  variance: z.string(),

  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedByName: z.string().nullable(),
  remarks: z.string().nullable(),

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
 * A shipment is LIQUIDATED when an approved liquidation exists AND commissions
 * have been computed. Neither half owns the transition: whichever lands second
 * applies it. Phase 4 wrote the commission half; this function is the whole
 * rule, called from both sides, so the two can never drift into disagreeing
 * about what "liquidated" means.
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
  facts: { liquidationApproved: boolean; commissionsComputed: boolean },
): ShipmentStatus | null {
  const earned = facts.liquidationApproved && facts.commissionsComputed;

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
