import { z } from 'zod';
import {
  commissionMethodSchema,
  isImplementedCommissionMethod,
  isRateBasedCommissionMethod,
  type CommissionMethod,
} from '../codes/commission-method';
import { crewRoleSchema } from '../codes/crew-role';
import {
  auditFieldsSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  rateStringSchema,
  requiredText,
} from './common';

export const commissionRuleSchema = auditFieldsSchema.extend({
  id: z.string(),
  name: z.string(),
  role: crewRoleSchema,
  method: commissionMethodSchema,
  rate: z.string().nullable(),
  fixedAmount: z.string().nullable(),
  clientId: z.string().nullable(),
  routeId: z.string().nullable(),
  priority: z.number().int(),
  effectiveFrom: z.string(),
  effectiveTo: z.string().nullable(),
  isActive: z.boolean(),
});

export type CommissionRule = z.infer<typeof commissionRuleSchema>;

const commissionRuleFields = z.object({
  name: requiredText(120),
  role: crewRoleSchema,
  method: commissionMethodSchema,
  rate: rateStringSchema.nullish().transform((value) => value ?? null),
  fixedAmount: moneyStringSchema.nullish().transform((value) => value ?? null),
  /** Narrower scope wins at resolution time; null matches anything. */
  clientId: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? null),
  routeId: z
    .string()
    .min(1)
    .nullish()
    .transform((value) => value ?? null),
  priority: z.number().int().min(0).max(9999).default(0),
  effectiveFrom: isoDateTimeSchema,
  /** Null means open-ended. */
  effectiveTo: isoDateTimeSchema.nullish().transform((value) => value ?? null),
  isActive: z.boolean().default(true),
});

/**
 * A rule must carry the amount column its method actually reads, and only
 * that one.
 *
 * This is not tidiness. A PERCENT_OF_BASE rule with a stray `fixedAmount` set
 * reads, to anyone scanning the table, as though it pays a flat fee — and the
 * engine would silently ignore it. Refusing the combination keeps the row
 * honest about what it does.
 */
export function hasAmountMatchingMethod(value: {
  method: CommissionMethod;
  rate: string | null;
  fixedAmount: string | null;
}): boolean {
  return isRateBasedCommissionMethod(value.method)
    ? value.rate !== null && value.fixedAmount === null
    : value.fixedAmount !== null && value.rate === null;
}

export const AMOUNT_METHOD_MISMATCH_MESSAGE =
  'a percentage method needs rate (and no fixedAmount); a fixed method needs fixedAmount (and no rate)';

/** `effectiveTo` is exclusive, so equal endpoints would describe no window. */
export function hasOrderedEffectiveWindow(value: {
  effectiveFrom: string;
  effectiveTo: string | null;
}): boolean {
  return value.effectiveTo === null || value.effectiveFrom < value.effectiveTo;
}

export const EFFECTIVE_WINDOW_MESSAGE = 'effectiveTo must be later than effectiveFrom';

export const UNIMPLEMENTED_METHOD_MESSAGE =
  'that commission method holds a reserved code but is not implemented';

export const createCommissionRuleSchema = commissionRuleFields
  .refine((value) => isImplementedCommissionMethod(value.method), {
    message: UNIMPLEMENTED_METHOD_MESSAGE,
    path: ['method'],
  })
  .refine(hasAmountMatchingMethod, {
    message: AMOUNT_METHOD_MISMATCH_MESSAGE,
    path: ['rate'],
  })
  .refine(hasOrderedEffectiveWindow, {
    message: EFFECTIVE_WINDOW_MESSAGE,
    path: ['effectiveTo'],
  });

export type CreateCommissionRuleInput = z.infer<typeof createCommissionRuleSchema>;

/**
 * Partial update. As with crew members, the cross-field rules cannot run on a
 * fragment — the service re-applies them to the patch merged onto the stored
 * row.
 */
export const updateCommissionRuleSchema = commissionRuleFields.partial();

export type UpdateCommissionRuleInput = z.infer<typeof updateCommissionRuleSchema>;
