import { defineCodeSet } from './code-set';

/**
 * How a commission rule derives its amount. Stored as
 * `commission_rule.method` SMALLINT.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const CommissionMethod = {
  /** commissionableBase x rate. The default. */
  PERCENT_OF_BASE: 1,
  /** A flat amount per trip, regardless of value. */
  FIXED_PER_TRIP: 2,
  /** A flat amount determined by the route. */
  FIXED_PER_ROUTE: 3,
  /** netRate x rate, skipping the gas deduction entirely. */
  PERCENT_OF_NET_RATE: 4,
  /** RESERVED — code allocated, not implemented. See IMPLEMENTED_COMMISSION_METHODS. */
  TIERED: 5,
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
  [CommissionMethod.TIERED]: 'Tiered (not implemented)',
};

/**
 * TIERED holds a permanent code so it can never be handed to something else,
 * but the engine does not implement it. The database CHECK constraint accepts
 * every allocated code — including this one — because the constraint guards
 * the code set, not the feature set. Rejecting an unimplemented method is the
 * service layer's job, using this list.
 */
export const IMPLEMENTED_COMMISSION_METHODS: readonly CommissionMethod[] = [
  CommissionMethod.PERCENT_OF_BASE,
  CommissionMethod.FIXED_PER_TRIP,
  CommissionMethod.FIXED_PER_ROUTE,
  CommissionMethod.PERCENT_OF_NET_RATE,
];

export function isImplementedCommissionMethod(method: CommissionMethod): boolean {
  return IMPLEMENTED_COMMISSION_METHODS.includes(method);
}

/**
 * Methods whose amount comes from `rate` (a percentage multiplier) rather than
 * from `fixedAmount` (money). Which column a rule must populate depends on it.
 */
export const RATE_BASED_COMMISSION_METHODS: readonly CommissionMethod[] = [
  CommissionMethod.PERCENT_OF_BASE,
  CommissionMethod.PERCENT_OF_NET_RATE,
];

export function isRateBasedCommissionMethod(method: CommissionMethod): boolean {
  return RATE_BASED_COMMISSION_METHODS.includes(method);
}
