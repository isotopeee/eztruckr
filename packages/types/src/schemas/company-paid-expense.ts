import { z } from 'zod';
import { auditFieldsSchema, idSchema, isoDateTimeSchema, optionalText } from './common';
import { positiveMoneyStringSchema } from './shipment';

/**
 * A trip cost the COMPANY paid directly, so it never passes through the crew's
 * cash and is never liquidated.
 *
 * WHY THIS IS ITS OWN TABLE, and not a flag on something that already exists.
 * Every other money line on a shipment answers a different question:
 *
 *   LiquidationLine  — the crew spent it, out of an allowance. Recognised as
 *                      cost when the liquidation is APPROVED, and measured
 *                      against what they were advanced.
 *   BillableExpense  — the company fronted it and REBILLS it to the client.
 *                      Revenue. What it cost lands wherever it was actually
 *                      paid from: here, or on a liquidation line.
 *   AdditionalCharge — a fee with no underlying cost at all. Pure revenue.
 *
 * A fleet-card fuel purchase, an office-paid toll account, a repair invoiced
 * to the company — none of those fit. They are real costs of the trip that no
 * crew member can account for, because no crew member ever held the money.
 * Before this table they had two homes and both were wrong: a liquidation line
 * would put a variance on a crew who were never advanced it, and a billable
 * expense would invent revenue from the client.
 *
 * RECOGNISED WHEN RECORDED, not on approval. There is no lifecycle to wait
 * for — the money has already left the company by the time anybody types the
 * row, so a status would only be a way of pretending otherwise.
 */
export const companyPaidExpenseSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  expenseCategoryId: z.string(),
  expenseCategoryName: z.string().nullable(),
  description: z.string().nullable(),
  amount: z.string(),
  spentAt: z.string(),
  payeeId: z.string().nullable(),
  payeeName: z.string().nullable(),
  /** The rule that applied to THIS row, frozen when it was written. */
  payeeRequired: z.boolean(),
  referenceNumber: z.string().nullable(),
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),
});

export type CompanyPaidExpense = z.infer<typeof companyPaidExpenseSchema>;

export const createCompanyPaidExpenseSchema = z.object({
  /**
   * Required, unlike a billable expense's. This row exists to be a cost in the
   * P&L and a cost with no category is one nobody can report on — whereas a
   * billable expense is primarily a thing to invoice, and its category is a
   * convenience.
   */
  expenseCategoryId: idSchema,
  description: optionalText(200),
  amount: positiveMoneyStringSchema,
  /** When the money actually left, which is not when somebody typed it in. */
  spentAt: isoDateTimeSchema,
  /**
   * Who the company paid. Optional here, required by the expense category —
   * see the note on `createLiquidationLineSchema.payeeId`.
   */
  payeeId: idSchema.nullish().transform((value) => value ?? null),
  /**
   * Invoice, official receipt or transaction reference. Optional, like every
   * other reference in the system: a mandatory one is answered with an invented
   * one, which reads like evidence and is not.
   */
  referenceNumber: optionalText(80),
  receiptId: idSchema.nullish().transform((value) => value ?? null),
});

export type CreateCompanyPaidExpenseInput = z.infer<typeof createCompanyPaidExpenseSchema>;

export const updateCompanyPaidExpenseSchema = createCompanyPaidExpenseSchema.partial();

export type UpdateCompanyPaidExpenseInput = z.infer<typeof updateCompanyPaidExpenseSchema>;
