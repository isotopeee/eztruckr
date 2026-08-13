import { z } from 'zod';
import { auditFieldsSchema, naturalCodeSchema, requiredText } from './common';

/**
 * Where an unordered category lands. Matches the column default in Postgres,
 * so the API and a direct insert agree.
 */
export const DEFAULT_EXPENSE_CATEGORY_SORT_ORDER = 10;

export const expenseCategorySchema = auditFieldsSchema.extend({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  requiresReceipt: z.boolean(),
  requiresPayee: z.boolean(),
  defaultCommissionable: z.boolean(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

export const createExpenseCategorySchema = z.object({
  code: naturalCodeSchema,
  name: requiredText(120),
  requiresReceipt: z.boolean().default(true),
  /**
   * Whether a disbursement in this category must name who was paid.
   *
   * Unlike `requiresReceipt`, this one is ENFORCED rather than stated — a
   * missing receipt is a judgement call for the approver, a missing payee is a
   * cost nobody can reconcile against a supplier statement.
   *
   * Defaults to true so relaxing a category is deliberate. The value is copied
   * onto each row it governs at write time and never read back live, so
   * changing it here affects new rows only.
   */
  requiresPayee: z.boolean().default(true),
  /**
   * Default for the commissionable flag when this category is used as a
   * billable expense. The per-row flag on the expense still wins.
   */
  defaultCommissionable: z.boolean().default(false),
  /**
   * Optional, and 10 rather than 0 when it is left out.
   *
   * The seeded categories are spaced 10 apart, so a category added without
   * thinking about order lands beside the first one instead of jumping ahead
   * of everything — and a 0 default made "I didn't say" indistinguishable from
   * "put this first". A gap of 10 also leaves room to slot something between
   * two existing categories without renumbering the rest.
   *
   * `nullish().transform()` rather than `default()`, because those two are not
   * the same thing here. A cleared number input reaches the API as an explicit
   * NULL, not as an absent field, and `.default()` only fires on `undefined` —
   * so a plain default would have rejected the very case this is meant to
   * serve, with a type error about null at that.
   */
  sortOrder: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .nullish()
    .transform((value) => value ?? DEFAULT_EXPENSE_CATEGORY_SORT_ORDER),
  isActive: z.boolean().default(true),
});

export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = createExpenseCategorySchema.partial();

export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;
