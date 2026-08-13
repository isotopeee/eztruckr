import { z } from 'zod';
import { payeeTypeSchema } from '../codes/payee-type';
import { auditFieldsSchema, naturalCodeSchema, optionalText, requiredText } from './common';

/**
 * Somebody OUTSIDE the company that money is disbursed to — a fuel station, a
 * ferry operator, a vulcanizing shop, a hauler's fixer.
 *
 * NOT a `ThirdParty`, and the two must not be merged. A third party is a broker
 * whose cut is netted off the gross rate (`gross - tpc = net`) and is never
 * disbursed at all; it carries a `defaultCommissionRate`, which is meaningless
 * on a tyre shop. A payee is the opposite side of the ledger: a specific amount
 * physically leaving, against a cost row. They are also locked at different
 * moments — a shipment's broker freezes when it leaves DRAFT, a liquidation
 * line's payee freezes when that liquidation is APPROVED.
 *
 * NOT a `Staff` either. Cash released to a crew member is an `Allowance`, whose
 * recipient is a `Staff` foreign key, because an advance to your own driver is
 * answerable for and liquidated while a vendor payment is neither.
 *
 * Mirrors `Client` field-for-field apart from `payeeType`: both are external
 * organisations that appear on Philippine paperwork, so both carry an address
 * and a TIN.
 */
export const payeeSchema = auditFieldsSchema.extend({
  id: z.string(),
  code: z.string(),
  payeeType: payeeTypeSchema,
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  tin: z.string().nullable(),
  isActive: z.boolean(),
});

export type Payee = z.infer<typeof payeeSchema>;

export const createPayeeSchema = z.object({
  code: naturalCodeSchema,
  /**
   * Stated, never inferred. No rule over the name distinguishes a sole
   * proprietor from a partnership, and the two produce different vouchers.
   */
  payeeType: payeeTypeSchema,
  name: requiredText(200),
  /**
   * A company's contact person. `expectsContactName` decides whether the form
   * asks; nothing requires it, because an individual payee is their own
   * contact and a duplicated name is one that later disagrees with itself.
   */
  contactName: optionalText(120),
  phone: optionalText(40),
  // Nullish before the email check, so "clear this field" stays expressible.
  email: z
    .string()
    .trim()
    .email()
    .nullish()
    .transform((value) => value ?? null),
  address: optionalText(300),
  /** Philippine taxpayer identification number, as printed on a voucher. */
  tin: optionalText(20),
  isActive: z.boolean().default(true),
});

export type CreatePayeeInput = z.infer<typeof createPayeeSchema>;

export const updatePayeeSchema = createPayeeSchema.partial();

export type UpdatePayeeInput = z.infer<typeof updatePayeeSchema>;
