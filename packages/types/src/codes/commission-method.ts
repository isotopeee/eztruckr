import { defineCodeSet } from './code-set';

/**
 * How a commission rule derives its amount. Stored as
 * `commission_rule.method` SMALLINT and frozen onto
 * `commission.appliedMethod`.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 *
 * HISTORICAL NOTE. Code 5 briefly carried a `TIERED` method that no
 * specification ever asked for — a leftover from a tiered-rates feature that
 * was implemented and then fully reverted. It was reserved, unimplemented and
 * referenced by no row. Phase 4 restored it to FORMULA, the method the brief
 * always named at code 5. Nothing was reinterpreted, because nothing used it.
 */
export const CommissionMethod = {
  /** commissionableBase x rate. The default model. */
  PERCENT_OF_BASE: 1,
  /** A flat amount per trip, regardless of value. */
  FIXED_PER_TRIP: 2,
  /** A flat amount determined by the route. The rule must be route-scoped. */
  FIXED_PER_ROUTE: 3,
  /** netRate x rate, skipping the gas deduction entirely. */
  PERCENT_OF_NET_RATE: 4,
  /** An expression over the shipment field catalog. See commission/formula. */
  FORMULA: 5,
} as const;

export type CommissionMethod = (typeof CommissionMethod)[keyof typeof CommissionMethod];

const meta = defineCodeSet('CommissionMethod', CommissionMethod);

export const COMMISSION_METHOD_CODES = meta.codes;
export const isCommissionMethod = meta.isValid;
export const commissionMethodSchema = meta.schema;

export const COMMISSION_METHOD_LABELS: Readonly<Record<CommissionMethod, string>> = {
  [CommissionMethod.PERCENT_OF_BASE]: 'Percent of commissionable base',
  [CommissionMethod.FIXED_PER_TRIP]: 'Fixed amount per trip',
  [CommissionMethod.FIXED_PER_ROUTE]: 'Fixed amount per route',
  [CommissionMethod.PERCENT_OF_NET_RATE]: 'Percent of net rate',
  [CommissionMethod.FORMULA]: 'Formula over shipment fields',
};

/**
 * Every allocated method is implemented as of Phase 4. The helper survives so
 * that a future appended code can be reserved before its strategy exists,
 * without weakening the database CHECK — the constraint guards the code set,
 * not the feature set, and refusing an unimplemented method stays the service
 * layer's job.
 */
export const IMPLEMENTED_COMMISSION_METHODS: readonly CommissionMethod[] = [
  CommissionMethod.PERCENT_OF_BASE,
  CommissionMethod.FIXED_PER_TRIP,
  CommissionMethod.FIXED_PER_ROUTE,
  CommissionMethod.PERCENT_OF_NET_RATE,
  CommissionMethod.FORMULA,
];

export function isImplementedCommissionMethod(method: CommissionMethod): boolean {
  return IMPLEMENTED_COMMISSION_METHODS.includes(method);
}

/**
 * Which column a rule must populate depends on how its method reads.
 *
 * Rate-based methods take `rate` (a percentage multiplier), fixed methods take
 * `fixedAmount` (money), and FORMULA takes neither — it carries an expression
 * in `params`. A rule must fill exactly the one its method reads, so the row
 * cannot look like it pays one thing while paying another.
 */
export const RATE_BASED_COMMISSION_METHODS: readonly CommissionMethod[] = [
  CommissionMethod.PERCENT_OF_BASE,
  CommissionMethod.PERCENT_OF_NET_RATE,
];

export function isRateBasedCommissionMethod(method: CommissionMethod): boolean {
  return RATE_BASED_COMMISSION_METHODS.includes(method);
}

export const FIXED_COMMISSION_METHODS: readonly CommissionMethod[] = [
  CommissionMethod.FIXED_PER_TRIP,
  CommissionMethod.FIXED_PER_ROUTE,
];

export function isFixedCommissionMethod(method: CommissionMethod): boolean {
  return FIXED_COMMISSION_METHODS.includes(method);
}

/** Methods whose definition lives in the rule's `params` JSON. */
export function isParamBasedCommissionMethod(method: CommissionMethod): boolean {
  return method === CommissionMethod.FORMULA;
}
