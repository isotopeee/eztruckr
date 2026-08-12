import { z } from 'zod';

/**
 * Money crosses the wire as a decimal STRING, never a JSON number — a JSON
 * number is an IEEE-754 double and would silently reintroduce float error at
 * the API boundary.
 */
export const moneyStringSchema = z
  .string()
  .regex(/^-?\d{1,11}(\.\d{1,4})?$/, 'must be a decimal string with up to 4 decimal places');

/** A rate multiplier such as "0.2500" (= 25%). Bounded to [0, 1]. */
export const rateStringSchema = z
  .string()
  .regex(/^\d(\.\d{1,4})?$/, 'must be a decimal string such as "0.2500"')
  .refine((value) => Number(value) >= 0 && Number(value) <= 1, 'must be between 0 and 1');

export const cuidSchema = z.string().min(1);

/**
 * Audit columns are system-owned. This is the shape the API returns; it is
 * never accepted on input, which is why there is no corresponding input
 * schema.
 */
export const auditFieldsSchema = z.object({
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
});

export type AuditFields = z.infer<typeof auditFieldsSchema>;

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;
