import { z } from 'zod';
import { auditFieldsSchema, rateStringSchema } from './common';

/** System-wide defaults as returned by the API. */
export const systemSettingSchema = auditFieldsSchema.extend({
  id: z.literal('singleton'),
  gasExpenseDeductionRate: rateStringSchema,
  driverCommissionRate: rateStringSchema,
  helperCommissionRate: rateStringSchema,
  currencyCode: z.string(),
  timezone: z.string(),
});

export type SystemSetting = z.infer<typeof systemSettingSchema>;
