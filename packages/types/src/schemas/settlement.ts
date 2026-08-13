import { z } from 'zod';
import { disbursementModeSchema } from '../codes/disbursement-mode';
import { settlementStatusSchema } from '../codes/settlement-status';
import { auditFieldsSchema, cuidSchema, optionalText } from './common';

/**
 * What happened to the cash left over after a trip was liquidated.
 *
 * One per shipment. The amount is the variance, signed, and the movement is
 * documented exactly the way the release was — mode, optional reference,
 * optional attachment — so both directions of the trail read alike.
 */
export const settlementSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  shipmentNumber: z.string().nullable(),

  status: settlementStatusSchema,
  /** Positive = crew return cash, negative = company reimburses crew. */
  amount: z.string(),

  disbursementMode: disbursementModeSchema.nullable(),
  referenceNumber: z.string().nullable(),
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),

  settledAt: z.string().nullable(),
  settledBy: z.string().nullable(),
  settledByName: z.string().nullable(),
  remarks: z.string().nullable(),

  /** The crew debt carrying this balance into payout, when it was carried. */
  crewDeductionId: z.string().nullable(),
  crewDeductionRecovered: z.string().nullable(),

  /**
   * Whether this trip still counts towards "allowances outstanding".
   *
   * Derived from the status alone — CARRIED_TO_PAYOUT counts, because the
   * decision has been made but the money has not moved.
   */
  isOutstanding: z.boolean(),
});

export type Settlement = z.infer<typeof settlementSchema>;

/**
 * Recording that the money moved.
 *
 * The mode is required here even though the column is nullable: null means
 * "has not moved yet", and this endpoint is the assertion that it has.
 */
export const recordSettlementSchema = z.object({
  disbursementMode: disbursementModeSchema,
  referenceNumber: optionalText(80),
  receiptId: cuidSchema.nullish().transform((value) => value ?? null),
  remarks: optionalText(400),
});

export type RecordSettlementInput = z.infer<typeof recordSettlementSchema>;

/**
 * Recovering the balance from the crew's pay instead of in cash.
 *
 * `crewMemberId` is required and is not guessed. The settlement is per trip
 * because there is no honest way to attribute a returned amount to one release;
 * a payout deduction, by contrast, has to name a person, and the system does
 * not know which of the driver and the helper the company holds responsible.
 * Asking is the only answer that is not an invention.
 */
export const carrySettlementToPayoutSchema = z.object({
  crewMemberId: cuidSchema,
  /** Defaults to naming the shipment. Becomes the crew deduction's reason. */
  reason: optionalText(200),
});

export type CarrySettlementToPayoutInput = z.infer<typeof carrySettlementToPayoutSchema>;

/**
 * One line of the "allowances outstanding" alert.
 *
 * Reads `settlement.status` directly. Deriving this from the liquidation would
 * answer a different question — whether the spending was accounted for — and
 * would report a trip as clear while the crew still held the change.
 */
export const outstandingAllowanceSchema = z.object({
  shipmentId: z.string(),
  shipmentNumber: z.string(),
  status: settlementStatusSchema,
  amount: z.string(),
  approvedAt: z.string().nullable(),
});

export type OutstandingAllowance = z.infer<typeof outstandingAllowanceSchema>;

export const outstandingAllowanceReportSchema = z.object({
  items: z.array(outstandingAllowanceSchema),
  total: z.number().int().nonnegative(),
  /** Sum of the outstanding amounts, signed. */
  totalAmount: z.string(),
});

export type OutstandingAllowanceReport = z.infer<typeof outstandingAllowanceReportSchema>;
