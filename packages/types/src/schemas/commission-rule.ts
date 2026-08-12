import { z } from 'zod';
import {
  CommissionMethod,
  commissionMethodSchema,
  isFixedCommissionMethod,
  isImplementedCommissionMethod,
  isParamBasedCommissionMethod,
  isRateBasedCommissionMethod,
} from '../codes/commission-method';
import { FormulaError, validateFormulaExpression } from '../commission/formula-syntax';
import { crewRoleSchema } from '../codes/crew-role';
import {
  auditFieldsSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  rateStringSchema,
  requiredText,
} from './common';

/**
 * Configuration for methods that need more than a single column. Today only
 * FORMULA uses it.
 *
 * The expression is parsed here, at the schema boundary, so an invalid one is
 * refused before it can be stored — a rule that failed validation is never
 * persisted, and computation therefore never meets an expression it has not
 * already proved well-formed.
 */
export const formulaParamsSchema = z.object({
  expression: z
    .string()
    .trim()
    .min(1)
    .superRefine((value, context) => {
      try {
        validateFormulaExpression(value);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof FormulaError ? error.message : 'invalid expression',
        });
      }
    }),
});

export type FormulaParams = z.infer<typeof formulaParamsSchema>;

export const commissionRuleParamsSchema = formulaParamsSchema
  .nullish()
  .transform((value) => value ?? null);

export const commissionRuleSchema = auditFieldsSchema.extend({
  id: z.string(),
  name: z.string(),
  role: crewRoleSchema,
  method: commissionMethodSchema,
  rate: z.string().nullable(),
  fixedAmount: z.string().nullable(),
  params: formulaParamsSchema.nullable(),
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
  params: commissionRuleParamsSchema,
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
 * A rule must carry exactly what its method reads, and nothing it does not.
 *
 * This is not tidiness. A PERCENT_OF_BASE rule with a stray `fixedAmount` set
 * reads, to anyone scanning the table, as though it pays a flat fee — and the
 * engine would silently ignore it. Refusing the combination keeps the row
 * honest about what it does.
 *
 * Three shapes, one per family: percentage methods take `rate`, fixed methods
 * take `fixedAmount`, and FORMULA takes neither — its definition lives in
 * `params.expression`.
 */
export function hasAmountMatchingMethod(value: {
  method: CommissionMethod;
  rate: string | null;
  fixedAmount: string | null;
  params?: FormulaParams | null;
}): boolean {
  const params = value.params ?? null;

  if (isRateBasedCommissionMethod(value.method)) {
    return value.rate !== null && value.fixedAmount === null && params === null;
  }

  if (isFixedCommissionMethod(value.method)) {
    return value.fixedAmount !== null && value.rate === null && params === null;
  }

  if (isParamBasedCommissionMethod(value.method)) {
    return params !== null && value.rate === null && value.fixedAmount === null;
  }

  return false;
}

export const AMOUNT_METHOD_MISMATCH_MESSAGE =
  'a percentage method needs rate alone; a fixed method needs fixedAmount alone; a formula method needs params.expression alone';

/**
 * A FIXED_PER_ROUTE rule that names no route would pay the same flat amount on
 * every trip in the company — which is FIXED_PER_TRIP, under a name that says
 * otherwise. The distinction between the two methods is only meaningful if
 * this holds.
 */
export function hasRouteForRouteMethod(value: {
  method: CommissionMethod;
  routeId: string | null;
}): boolean {
  return value.method !== CommissionMethod.FIXED_PER_ROUTE || value.routeId !== null;
}

export const ROUTE_METHOD_NEEDS_ROUTE_MESSAGE =
  'a fixed-amount-per-route rule must be scoped to a route, or it would pay the same on every trip';

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
  .refine(hasRouteForRouteMethod, {
    message: ROUTE_METHOD_NEEDS_ROUTE_MESSAGE,
    path: ['routeId'],
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
