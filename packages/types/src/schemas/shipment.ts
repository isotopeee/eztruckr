import { z } from 'zod';
import { crewRoleSchema } from '../codes/crew-role';
import { isShipmentStatus, shipmentStatusSchema, ShipmentStatus } from '../codes/shipment-status';
import {
  auditFieldsSchema,
  cuidSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  optionalText,
  rateStringSchema,
  requiredText,
} from './common';

/**
 * A positive money amount. Charges and rates are never negative: a refund is
 * its own line, not a negated one, so that a total is always a sum of things
 * that happened.
 */
export const positiveMoneyStringSchema = moneyStringSchema.refine(
  (value) => !value.startsWith('-'),
  'must not be negative',
);

// ---------------------------------------------------------------------------
// Charge lines
// ---------------------------------------------------------------------------

const chargeLineFields = {
  description: requiredText(200),
  amount: positiveMoneyStringSchema,
  /**
   * Whether this line feeds the commission base. Defaults to false: including
   * a charge in crew pay is a deliberate act, and the safer default when
   * someone forgets is the company keeping the money, not paying it out twice.
   */
  isCommissionable: z.boolean().default(false),
};

export const billableExpenseSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  expenseCategoryId: z.string().nullable(),
  expenseCategoryName: z.string().nullable(),
  description: z.string(),
  amount: z.string(),
  isCommissionable: z.boolean(),
});

export type BillableExpense = z.infer<typeof billableExpenseSchema>;

export const createBillableExpenseSchema = z.object({
  ...chargeLineFields,
  expenseCategoryId: cuidSchema.nullish().transform((value) => value ?? null),
});

export type CreateBillableExpenseInput = z.infer<typeof createBillableExpenseSchema>;
export const updateBillableExpenseSchema = createBillableExpenseSchema.partial();
export type UpdateBillableExpenseInput = z.infer<typeof updateBillableExpenseSchema>;

export const additionalChargeSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  description: z.string(),
  amount: z.string(),
  isCommissionable: z.boolean(),
});

export type AdditionalCharge = z.infer<typeof additionalChargeSchema>;

export const createAdditionalChargeSchema = z.object(chargeLineFields);
export type CreateAdditionalChargeInput = z.infer<typeof createAdditionalChargeSchema>;
export const updateAdditionalChargeSchema = createAdditionalChargeSchema.partial();
export type UpdateAdditionalChargeInput = z.infer<typeof updateAdditionalChargeSchema>;

// ---------------------------------------------------------------------------
// Shipment
// ---------------------------------------------------------------------------

export const shipmentSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentNumber: z.string(),
  status: shipmentStatusSchema,

  clientId: z.string(),
  clientName: z.string().nullable(),
  thirdPartyId: z.string().nullable(),
  thirdPartyName: z.string().nullable(),
  routeId: z.string().nullable(),
  routeName: z.string().nullable(),
  truckId: z.string().nullable(),
  truckPlateNumber: z.string().nullable(),

  origin: z.string(),
  destination: z.string(),
  cargoDescription: z.string().nullable(),

  driverId: z.string().nullable(),
  driverName: z.string().nullable(),
  helperId: z.string().nullable(),
  helperName: z.string().nullable(),

  dispatchedAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  closedAt: z.string().nullable(),

  // The rate chain, all computed by the API.
  grossRate: z.string(),
  tpcAmount: z.string(),
  netRate: z.string(),
  appliedTpcRate: z.string().nullable(),

  // The commission chain. Null until commissions are computed.
  appliedGasDeductionRate: z.string().nullable(),
  gasRateOverrideReason: z.string().nullable(),
  commissionableCharges: z.string().nullable(),
  grossForCommission: z.string().nullable(),
  gasDeductionAmount: z.string().nullable(),
  commissionableBase: z.string().nullable(),
  commissionsComputedAt: z.string().nullable(),

  /**
   * The stored commission chain predates a charge on the shipment, so the
   * figures on screen no longer follow from the line items beside them.
   *
   * Derived by comparing timestamps rather than stored, so it cannot disagree
   * with the rows it describes. Only present on the detail response; the list
   * does not pay for the extra queries.
   */
  commissionsStale: z.boolean().default(false),
});

export type Shipment = z.infer<typeof shipmentSchema>;

/**
 * The third-party cut, expressed the way it was actually agreed.
 *
 * A broker deal is struck either as a percentage of gross or as a flat peso
 * figure, and which one it was matters later: `appliedTpcRate` is null for a
 * flat deal and set for a percentage one, so a change to the broker's standard
 * rate can never rewrite what this shipment paid. Accepting both at once would
 * make that record ambiguous, so exactly one is allowed.
 */
export const TPC_EXCLUSIVE_MESSAGE =
  'give either tpcRate or tpcAmount, not both — which one was agreed is what appliedTpcRate records';

export const TPC_WITHOUT_BROKER_MESSAGE =
  'a shipment with no third party has no broker cut, so leave tpcRate and tpcAmount empty';

export function hasUnambiguousTpc(value: {
  tpcRate?: string | null;
  tpcAmount?: string | null;
}): boolean {
  return !(value.tpcRate != null && value.tpcAmount != null);
}

export function hasBrokerForTpc(value: {
  thirdPartyId?: string | null;
  tpcRate?: string | null;
  tpcAmount?: string | null;
}): boolean {
  if (value.thirdPartyId != null) return true;
  return value.tpcRate == null && value.tpcAmount == null;
}

const shipmentFields = z.object({
  shipmentNumber: requiredText(40),
  clientId: cuidSchema,
  thirdPartyId: cuidSchema.nullish().transform((value) => value ?? null),
  routeId: cuidSchema.nullish().transform((value) => value ?? null),
  truckId: cuidSchema.nullish().transform((value) => value ?? null),

  /**
   * Snapshotted onto the shipment rather than read through the route, so
   * renaming a route later does not rewrite where old trips went.
   */
  origin: requiredText(160),
  destination: requiredText(160),
  cargoDescription: optionalText(400),

  grossRate: positiveMoneyStringSchema,
  tpcRate: rateStringSchema.nullish().transform((value) => value ?? null),
  tpcAmount: positiveMoneyStringSchema.nullish().transform((value) => value ?? null),
});

export const createShipmentSchema = shipmentFields
  .refine(hasUnambiguousTpc, { message: TPC_EXCLUSIVE_MESSAGE, path: ['tpcAmount'] })
  .refine(hasBrokerForTpc, { message: TPC_WITHOUT_BROKER_MESSAGE, path: ['thirdPartyId'] });

export type CreateShipmentInput = z.infer<typeof createShipmentSchema>;

/** Cross-field rules cannot run on a fragment; the service re-applies them. */
export const updateShipmentSchema = shipmentFields.partial();
export type UpdateShipmentInput = z.infer<typeof updateShipmentSchema>;

// ---------------------------------------------------------------------------
// Crew assignment
// ---------------------------------------------------------------------------

/**
 * Both slots are set in one call, because they are one decision. Sending them
 * separately would let a shipment sit briefly with a driver who is also the
 * helper, and the check for that would have nothing to compare against.
 * Explicit null clears a slot.
 */
export const assignCrewSchema = z.object({
  driverId: cuidSchema.nullish().transform((value) => value ?? null),
  helperId: cuidSchema.nullish().transform((value) => value ?? null),
});

export type AssignCrewInput = z.infer<typeof assignCrewSchema>;

export const SAME_PERSON_BOTH_SLOTS_MESSAGE =
  'one person cannot be both the driver and the helper on the same trip';

// ---------------------------------------------------------------------------
// Status transitions and the gas rate override
// ---------------------------------------------------------------------------

export const transitionShipmentSchema = z.object({
  to: shipmentStatusSchema,
  /** Defaults to now; supplied so a trip can be recorded after the fact. */
  occurredAt: isoDateTimeSchema.nullish().transform((value) => value ?? null),
});

export type TransitionShipmentInput = z.infer<typeof transitionShipmentSchema>;

/**
 * Overriding the gas deduction rate for one shipment.
 *
 * A reason is mandatory, and that is the whole point of the endpoint: the rate
 * moves the commission base for every crew member on the trip, so an
 * unexplained override is indistinguishable from a typo when someone reviews
 * the payout months later. Sending a null rate reverts to the system default
 * and clears the reason with it.
 */
export const setGasRateOverrideSchema = z
  .object({
    rate: rateStringSchema.nullish().transform((value) => value ?? null),
    reason: optionalText(400),
  })
  .refine((value) => value.rate === null || value.reason !== null, {
    message: 'an override needs a reason',
    path: ['reason'],
  })
  .refine((value) => value.rate !== null || value.reason === null, {
    message: 'clearing the override clears the reason too',
    path: ['reason'],
  });

export type SetGasRateOverrideInput = z.infer<typeof setGasRateOverrideSchema>;

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

export const shipmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  // Query strings arrive as text, so coerce first, then check membership
  // against the code set rather than trusting the number.
  status: z.coerce.number().int().refine(isShipmentStatus, 'unknown shipment status').optional(),
  clientId: cuidSchema.optional(),
  crewMemberId: cuidSchema.optional(),
});

export type ShipmentListQuery = z.infer<typeof shipmentListQuerySchema>;

/**
 * Statuses a dashboard treats as "needs attention from accounting". Declared
 * here so the API filter and any UI badge agree on what awaiting-liquidation
 * means, rather than each hard-coding a status.
 */
export const AWAITING_LIQUIDATION_STATUSES: readonly ShipmentStatus[] = [
  ShipmentStatus.PENDING_LIQUIDATION,
];

export const crewRoleAssignmentSchema = crewRoleSchema;
