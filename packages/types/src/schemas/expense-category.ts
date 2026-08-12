import { z } from 'zod';
import { auditFieldsSchema, naturalCodeSchema, requiredText } from './common';

export const expenseCategorySchema = auditFieldsSchema.extend({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  requiresReceipt: z.boolean(),
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
   * Default for the commissionable flag when this category is used as a
   * billable expense. The per-row flag on the expense still wins.
   */
  defaultCommissionable: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = createExpenseCategorySchema.partial();

export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;
