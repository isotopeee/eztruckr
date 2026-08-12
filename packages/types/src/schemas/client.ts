import { z } from 'zod';
import { auditFieldsSchema, naturalCodeSchema, optionalText, requiredText } from './common';

export const clientSchema = auditFieldsSchema.extend({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  contactName: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  address: z.string().nullable(),
  tin: z.string().nullable(),
  isActive: z.boolean(),
});

export type Client = z.infer<typeof clientSchema>;

export const createClientSchema = z.object({
  code: naturalCodeSchema,
  name: requiredText(200),
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
  /** Philippine taxpayer identification number, as printed on invoices. */
  tin: optionalText(20),
  isActive: z.boolean().default(true),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;

export const updateClientSchema = createClientSchema.partial();

export type UpdateClientInput = z.infer<typeof updateClientSchema>;
