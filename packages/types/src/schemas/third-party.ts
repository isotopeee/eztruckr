import { z } from 'zod';
import { auditFieldsSchema, optionalText, rateStringSchema, requiredText } from './common';

/** A broker or agent who brings freight and takes a cut off the gross rate. */
export const thirdPartySchema = auditFieldsSchema.extend({
  id: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  defaultCommissionRate: z.string().nullable(),
  isActive: z.boolean(),
});

export type ThirdParty = z.infer<typeof thirdPartySchema>;

export const createThirdPartySchema = z.object({
  name: requiredText(200),
  contactName: optionalText(120),
  phone: optionalText(40),
  email: z
    .string()
    .trim()
    .email()
    .nullish()
    .transform((value) => value ?? null),
  /**
   * Only a default offered when creating a shipment. What actually governs is
   * the shipment's own frozen tpcAmount / appliedTpcRate, so changing this
   * never moves money that has already been computed.
   */
  defaultCommissionRate: rateStringSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

export type CreateThirdPartyInput = z.infer<typeof createThirdPartySchema>;

export const updateThirdPartySchema = createThirdPartySchema.partial();

export type UpdateThirdPartyInput = z.infer<typeof updateThirdPartySchema>;
