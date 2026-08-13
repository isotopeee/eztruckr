import { z } from 'zod';
import { crewRoleSchema } from '../codes/crew-role';
import { isShipmentStatus, shipmentStatusSchema, ShipmentStatus } from '../codes/shipment-status';
import {
  auditFieldsSchema,
  idSchema,
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
  expenseCategoryId: idSchema.nullish().transform((value) => value ?? null),
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

  /**
   * The rate chain, all computed by the API.
   *
   * NULLABLE ONLY BECAUSE OF REDACTION, never because the shipment lacks them:
   * every stored row has a gross, a TPC and a net. A CREW session is served
   * nulls here — see `redactRevenueForCrew` in the shipments controller — so
   * what the company charges the client and what the broker takes stay out of
   * the crew portal. The web renders a null figure as "—" already, which is why
   * this is expressible as nulls rather than as a second response shape.
   */
  grossRate: z.string().nullable(),
  tpcAmount: z.string().nullable(),
  netRate: z.string().nullable(),
  appliedTpcRate: z.string().nullable(),

  /** Input: the rate somebody asked this trip to use. Null means the default. */
  gasRateOverride: z.string().nullable(),
  gasRateOverrideReason: z.string().nullable(),

  // The commission chain. Null until commissions are computed.
  /** Output: the rate the last computation actually used. */
  appliedGasDeductionRate: z.string().nullable(),
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

  /**
   * The sum of every allowance released on this trip.
   *
   * The figure the variance is measured against, so it is derived server-side
   * and sent — never one release, and never a stored total that the second
   * release would have to overwrite. Detail response only, like
   * `commissionsStale`; the list does not pay for the extra query.
   */
  totalAdvanced: z.string().default('0.00'),
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

/**
 * `shipmentNumber` is ABSENT here on purpose.
 *
 * It is generated by the server — see `shipment-number.ts` — and accepting it
 * on input would make the generated value a suggestion. The validation pipe
 * strips undeclared fields, so leaving it out of this object is also what stops
 * a request body supplying its own, exactly as it does for `status` and
 * `netRate`. Not on the update schema either: a number that anybody can
 * overwrite carries none of the guarantees that made generating it worthwhile.
 */
const shipmentFields = z.object({
  clientId: idSchema,
  thirdPartyId: idSchema.nullish().transform((value) => value ?? null),
  routeId: idSchema.nullish().transform((value) => value ?? null),
  truckId: idSchema.nullish().transform((value) => value ?? null),

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
  driverId: idSchema.nullish().transform((value) => value ?? null),
  helperId: idSchema.nullish().transform((value) => value ?? null),
});

export type AssignCrewInput = z.infer<typeof assignCrewSchema>;

export const SAME_PERSON_BOTH_SLOTS_MESSAGE =
  'one person cannot be both the driver and the helper on the same trip';

/**
 * The truck doing the trip. Its own call, separate from the crew.
 *
 * WHY NOT PART OF `assignCrew`. The two are assigned by the same person at
 * roughly the same moment, which is the only thing they have in common. Crew
 * assignment is one decision about two slots — that is why driver and helper
 * move together, so nobody can briefly be both. A truck has no such pairing,
 * and it obeys a different rule about when it may change: a driver cannot be
 * swapped once a commission has been paid to them, while a truck is paid
 * nothing and feeds no figure in the money chain, so a breakdown mid-trip can
 * still be recorded honestly afterwards.
 *
 * Explicit null clears the slot, which a draft may want and a dispatched trip
 * may not — the service refuses to leave a dispatched shipment without one.
 */
export const assignTruckSchema = z.object({
  truckId: idSchema.nullish().transform((value) => value ?? null),
});

export type AssignTruckInput = z.infer<typeof assignTruckSchema>;

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
 * The gas rate as it stands on one shipment.
 *
 * Three separate numbers, deliberately not collapsed into one: what the
 * company uses by default, what this trip was told to use, and what the last
 * computation actually used. The last two diverge whenever an override is
 * changed after computing, and a screen that showed a single "rate" would have
 * to pick one and be silently wrong about the other.
 */
export const gasRateContextSchema = z.object({
  systemDefault: z.string(),
  /** Null when this shipment simply takes the default. */
  override: z.string().nullable(),
  reason: z.string().nullable(),
  isOverride: z.boolean(),
  /** What the next computation will use: override, or the default. */
  effective: z.string(),
  /** What the last computation did use. Null until commissions are computed. */
  frozen: z.string().nullable(),
});

export type GasRateContext = z.infer<typeof gasRateContextSchema>;

/**
 * Overriding the gas deduction rate for one shipment.
 *
 * A reason is mandatory, and that is the whole point of the endpoint: the rate
 * moves the commission base for every crew member on the trip, so an
 * unexplained override is indistinguishable from a typo when someone reviews
 * the payout months later. Sending a null rate reverts to the system default
 * and clears the reason with it.
 *
 * Both halves of that rule are also a database CHECK
 * (`shipment_gas_rate_override_needs_reason`), so the pairing survives any
 * write path, not just this one.
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
  clientId: idSchema.optional(),
  staffId: idSchema.optional(),
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
