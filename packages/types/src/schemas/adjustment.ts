import { z } from 'zod';
import { AdjustmentDirection, adjustmentDirectionSchema } from '../codes/adjustment-direction';
import { money, sum, toDecimalString, zero } from '../money';
import { commissionSchema } from './commission';
import { auditFieldsSchema, cuidSchema, requiredText } from './common';
import { positiveMoneyStringSchema } from './shipment';

/**
 * A manual increase or decrease to what a crew member is paid.
 *
 * WHY IT IS NOT AN EDIT TO THE COMMISSION. A `Commission` row states its own
 * arithmetic — base x rate = amount, from values stored on the row — and that
 * is what lets somebody re-derive a voucher months later without consulting a
 * rule that may since have changed. Folding a ₱500 bonus into `amount` would
 * make the row lie about itself. Folding it in anywhere else on the commission
 * would be erased by the next recompute, which soft-deletes every commission on
 * the trip and writes fresh ones.
 *
 * So an adjustment is its own row, attached to the TRIP and the PERSON rather
 * than to the computed commission — both of which survive a recompute. What is
 * owed is the sum of the two, taken when something asks.
 *
 * THE DIRECTION CARRIES THE SIGN. `amount` is always a positive magnitude, and
 * a CHECK enforces it, so "decrease ₱300" cannot also be written as "increase
 * −₱300" — two spellings of one fact is how a total ends up wrong in a way
 * nobody can see by reading a row.
 */
export const adjustmentSchema = auditFieldsSchema.extend({
  id: z.string(),
  staffId: z.string(),
  staffName: z.string().nullable(),

  /** Null for a standing adjustment against the person rather than a trip. */
  shipmentId: z.string().nullable(),
  shipmentNumber: z.string().nullable(),

  direction: adjustmentDirectionSchema,
  amount: z.string(),

  /**
   * The amount with its direction applied: "500.00" or "-300.00".
   *
   * Computed here rather than in the browser, like every other figure that
   * crosses the wire. A screen that had to apply the sign itself would be one
   * more place that can get it backwards.
   */
  signedAmount: z.string(),

  reason: z.string(),

  approvedBy: z.string(),
  approvedByName: z.string().nullable(),
  approvedAt: z.string(),

  /** Set once a payout run has picked it up. While set, the row is frozen. */
  payoutLineId: z.string().nullable(),
  isEditable: z.boolean(),
});

export type Adjustment = z.infer<typeof adjustmentSchema>;

export const createAdjustmentSchema = z.object({
  staffId: cuidSchema,
  /**
   * Omit for a standing adjustment. When given, the service checks the crew
   * member actually worked that trip — an adjustment against a trip somebody
   * was not on is a typo with a peso value.
   */
  shipmentId: cuidSchema.nullish().transform((value) => value ?? null),
  direction: adjustmentDirectionSchema,
  amount: positiveMoneyStringSchema,
  /**
   * Mandatory, and the point of the record. Approving a change to somebody's
   * pay without saying why leaves the next person to look at it unable to tell
   * a decision from a mistake.
   */
  reason: requiredText(400),
});

export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

/**
 * Direction, amount and reason may be corrected while the adjustment is
 * unpaid. Who it belongs to may not: moving an adjustment to another crew
 * member or another trip is a different decision, and the audit trail should
 * show the first one being withdrawn rather than quietly re-aimed.
 */
export const updateAdjustmentSchema = createAdjustmentSchema
  .pick({ direction: true, amount: true, reason: true })
  .partial();

export type UpdateAdjustmentInput = z.infer<typeof updateAdjustmentSchema>;

export const adjustmentListQuerySchema = z.object({
  staffId: cuidSchema.optional(),
  shipmentId: cuidSchema.optional(),
  /** Only those a payout run has not taken yet — the queue for the next one. */
  unpaidOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((value) => value === true || value === 'true'),
});

export type AdjustmentListQuery = z.infer<typeof adjustmentListQuerySchema>;

// ---------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------

/** One adjustment reduced to what it contributes to a total. */
export interface SignedAdjustment {
  direction: AdjustmentDirection;
  amount: string;
}

/**
 * The amount with its direction applied, as a decimal string.
 *
 * The ONE place the sign is decided. Everything that totals adjustments goes
 * through here, so a screen and a payout run can never disagree about which way
 * a DECREASE points.
 */
export function signedAdjustmentAmount(entry: SignedAdjustment): string {
  const magnitude = money(entry.amount);

  return toDecimalString(
    entry.direction === AdjustmentDirection.DECREASE ? zero().subtract(magnitude) : magnitude,
  );
}

/** The net effect of a set of adjustments, positive or negative. */
export function sumAdjustments(entries: readonly SignedAdjustment[]): string {
  return toDecimalString(sum(entries.map(signedAdjustmentAmount)));
}

// ---------------------------------------------------------------------------
// What one crew member is actually owed for one trip
// ---------------------------------------------------------------------------

/**
 * The computed commission, the adjustments against it, and the total.
 *
 * A ROLL-UP, never a stored row. The commission stays frozen and self-verifying
 * and the adjustments stay separately explainable; this is only the addition,
 * done server-side because the web app does not do money arithmetic.
 *
 * `commission` is nullable because an adjustment can legitimately exist before
 * commissions are computed — somebody agreeing a bonus on the day does not have
 * to wait for accounting — and because a trip whose crew changed can leave an
 * adjustment naming a person who no longer has a commission on it. Both show up
 * here rather than being silently dropped from the total.
 */
export const crewPayLineSchema = z.object({
  staffId: z.string(),
  staffName: z.string(),
  commission: commissionSchema.nullable(),
  commissionAmount: z.string(),
  adjustments: z.array(adjustmentSchema),
  adjustmentsTotal: z.string(),
  netAmount: z.string(),
});

export type CrewPayLine = z.infer<typeof crewPayLineSchema>;
