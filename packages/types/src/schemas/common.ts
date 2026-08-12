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

/** A required piece of free text, trimmed. */
export const requiredText = (max = 200) => z.string().trim().min(1).max(max);

/**
 * Optional free text that normalises "" and undefined to null, so a cleared
 * field in a form and an omitted field in an API call mean the same thing in
 * the database rather than producing an empty string nobody can search for.
 */
export const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

/**
 * A natural key such as `CLT-SMT` or `FUEL`. Uppercase so lookups and imports
 * never turn on case, and constrained because these appear in exports and
 * printed vouchers.
 */
export const naturalCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .min(2)
  .max(32)
  .regex(/^[A-Z0-9][A-Z0-9 _-]*$/, 'use letters, digits, spaces, hyphens or underscores');

/** A non-money physical quantity (kilograms, kilometres) as a decimal string. */
export const quantityStringSchema = z
  .string()
  .regex(/^\d{1,8}(\.\d{1,2})?$/, 'must be a non-negative decimal string');

/** An ISO-8601 instant. Storage is UTC; Asia/Manila is a display concern. */
export const isoDateTimeSchema = z.string().datetime({ offset: true });

/**
 * What actually happened when a record was asked to go away.
 *
 * Removal is not one operation. A record nothing refers to can leave properly;
 * one that history depends on must stay readable and is deactivated instead.
 * The caller is told which occurred rather than being left to infer it from a
 * 204, because "delete" that silently means "deactivate" is how a user ends up
 * believing a truck is gone while it still prints on last month's vouchers.
 */
export const REMOVAL_OUTCOMES = ['SOFT_DELETED', 'HARD_DELETED', 'DEACTIVATED'] as const;

export const removalOutcomeSchema = z.enum(REMOVAL_OUTCOMES);
export type RemovalOutcome = z.infer<typeof removalOutcomeSchema>;

/** One reason a record could not be removed: what refers to it, and how often. */
export const referenceCountSchema = z.object({
  /** Human-readable entity name, e.g. "shipments". */
  entity: z.string(),
  count: z.number().int().nonnegative(),
});

export const removalResultSchema = z.object({
  outcome: removalOutcomeSchema,
  /** Empty when nothing referred to the record. */
  references: z.array(referenceCountSchema),
});

export type ReferenceCount = z.infer<typeof referenceCountSchema>;
export type RemovalResult = z.infer<typeof removalResultSchema>;

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

/**
 * Query string for any master data list.
 *
 * `includeInactive` defaults to false because the common case is choosing a
 * record for new work, where a sold truck or a departed driver must not
 * appear. Management screens ask for them explicitly.
 */
export const masterDataListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  includeInactive: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .default(false)
    .transform((value) => value === true || value === 'true'),
});

export type MasterDataListQuery = z.infer<typeof masterDataListQuerySchema>;

/** A page of results, with enough metadata for the table footer. */
export function pageSchema<TItem extends z.ZodTypeAny>(item: TItem) {
  return z.object({
    items: z.array(item),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    pageSize: z.number().int().positive(),
  });
}

export interface Page<TItem> {
  items: TItem[];
  total: number;
  page: number;
  pageSize: number;
}
