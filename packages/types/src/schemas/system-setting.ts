import { z } from 'zod';
import { auditFieldsSchema, isoDateTimeSchema, rateStringSchema } from './common';

/**
 * System-wide defaults as returned by the API.
 *
 * Commission rates are deliberately absent: `CommissionRule` is the only
 * source of truth for what crew are paid. See the note on the `SystemSetting`
 * model in schema.prisma for why the fallback was removed.
 */
export const systemSettingSchema = auditFieldsSchema.extend({
  id: z.literal('singleton'),
  gasExpenseDeductionRate: rateStringSchema,
  currencyCode: z.string(),
  timezone: z.string(),
});

export type SystemSetting = z.infer<typeof systemSettingSchema>;

/**
 * Editable settings.
 *
 * `id`, `currencyCode` and `timezone` are absent on purpose: the first is a
 * literal, and the other two are not a rate anyone should be able to change
 * from a settings form while money computed under the old one is already
 * recorded.
 */
export const updateSystemSettingSchema = z
  .object({
    gasExpenseDeductionRate: rateStringSchema,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'supply at least one setting to change',
  });

export type UpdateSystemSettingInput = z.infer<typeof updateSystemSettingSchema>;

/**
 * One recorded change to a setting.
 *
 * Derived from AuditLog rows, so the history survives even if the setting is
 * later changed back — "it was 0.25 the whole time" and "it was 0.30 for three
 * days in March" have to be distinguishable when a payout is questioned.
 */
export const settingChangeSchema = z.object({
  id: z.string(),
  occurredAt: isoDateTimeSchema,
  actorId: z.string().nullable(),
  actorName: z.string().nullable(),
  field: z.string(),
  previousValue: z.string().nullable(),
  newValue: z.string().nullable(),
});

export type SettingChange = z.infer<typeof settingChangeSchema>;
