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
  sortDirectionSchema,
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

/**
 * A cost the company fronted and rebills to the client.
 *
 * THE SAME FIELDS AS A COMPANY-PAID EXPENSE, deliberately, plus
 * `isCommissionable`. Both record one act of spending on a trip; what separates
 * them is where the money ends up, not what is worth knowing about it. The two
 * forms used to ask different questions — this one wanted only a description
 * and an amount — which meant the same permit fee was recorded with a payee and
 * a date on one screen and without them on the other, and the reason was
 * nothing better than which card was written first.
 *
 * WHOSE MONEY WENT OUT is `liquidationLineId`, and it decides whether this row
 * is a cost as well as revenue. Null means the office paid, so the row is the
 * whole record of the disbursement. Set means the crew paid out of cash they
 * hold, and it names the CLAIM the cost is counted on — counting it here too
 * would book the same peso twice. See `grossProfitSchema`.
 *
 * THE CLAIM, NOT JUST THE ACCOUNT. Naming the account alone said the cost would
 * turn up somewhere on it and left nobody able to say where, so a rebill could
 * defer to an account that never filed the expense and the cost went uncounted
 * in both places. `liquidationId` is still returned — it is what the account is
 * — but it is derived from the claim, never sent.
 *
 * HOW MUCH COMES BACK is `billedAmount`, which need not be the whole `amount`.
 * Recovery is routinely partial, and the two are separate figures so a
 * shortfall can be recorded as one rather than faked by understating what was
 * paid. What the company absorbed is the gap between them, and is derived
 * wherever it is shown rather than stored anywhere.
 */
export const billableExpenseSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  /** The claim carrying the cost, or null when the company fronted it. */
  liquidationLineId: z.string().nullable(),
  /** The account that claim is on. Derived from it; moves with it. */
  liquidationId: z.string().nullable(),
  /** What the CLAIM says was spent. Null when there is no claim. */
  liquidationLineAmount: z.string().nullable(),
  /**
   * `amount` less `liquidationLineAmount` — this row's account of what was
   * spent against the crew's. Null when there is no claim to differ from.
   *
   * POSITIVE means the rebill says more was paid than the claim records;
   * negative means less. NOT AN ERROR EITHER WAY, which is why it is displayed
   * rather than refused: rebilling part of a larger claim is an ordinary thing
   * to do, and so is a claim later corrected upward. What it is not is
   * invisible — the P&L costs the CLAIM, so a rebill quietly disagreeing with
   * the figure that is actually counted is worth seeing.
   *
   * Derived on read, never stored, so it cannot drift from the two figures it
   * comes from. Computed here rather than in the browser for the same reason
   * every other figure is: one definition, and no float arithmetic on decimal
   * strings.
   */
  liquidationVariance: z.string().nullable(),
  /**
   * Who is answerable for that account, for a screen that has to say which one.
   *
   * Null both when there is no link at all and when the account has nobody
   * named to it — the one the delivery backstop opens — so a reader must check
   * `liquidationId` to tell "company-paid" from "nobody's name on it yet". The
   * two are different facts and neither is inferable from this name.
   */
  liquidationCustodianName: z.string().nullable(),
  /**
   * Which of that person's accounts on the trip carries the cost.
   *
   * Null exactly when `liquidationId` is: one person may hold several accounts
   * on one trip, so the custodian's name alone no longer says which of them
   * promised to carry this rebill's cost.
   */
  liquidationSequence: z.number().int().nullable(),
  expenseCategoryId: z.string().nullable(),
  expenseCategoryName: z.string().nullable(),
  description: z.string().nullable(),
  /** What was spent. Becomes a cost when no liquidation carries it. */
  amount: z.string(),
  /** What the client is charged for it. Revenue, always. */
  billedAmount: z.string(),
  spentAt: z.string(),
  isCommissionable: z.boolean(),
  payeeId: z.string().nullable(),
  payeeName: z.string().nullable(),
  /** The rule that applied to THIS row, frozen when it was written. */
  payeeRequired: z.boolean(),
  referenceNumber: z.string().nullable(),
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),
});

export type BillableExpense = z.infer<typeof billableExpenseSchema>;

export const createBillableExpenseSchema = z.object({
  description: optionalText(200),
  /** What was spent — the figure on the receipt, not the one on the invoice. */
  amount: positiveMoneyStringSchema,
  /**
   * What the client is charged, which defaults to the whole amount.
   *
   * DEFAULTED RATHER THAN REQUIRED, because full recovery is the ordinary case
   * and every caller written before partial recovery existed meant exactly
   * that. Making it required would have turned a new capability into a breaking
   * change for the common path, and defaulting it to anything else would
   * silently start absorbing costs nobody chose to absorb.
   *
   * Not constrained to be at most `amount`: billing above cost is a markup and
   * belongs on an additional charge, but refusing it here would also refuse the
   * correction of a row typed the wrong way round.
   */
  billedAmount: positiveMoneyStringSchema.optional(),
  isCommissionable: chargeLineFields.isCommissionable,
  /**
   * Still nullish, unlike a company-paid expense's.
   *
   * The asymmetry is about what the row is FOR rather than about the form: a
   * company-paid expense exists to be a cost in the P&L, and an uncategorised
   * cost is one nobody can report on, whereas a billable expense is primarily a
   * thing to invoice. Rows written before there was a category to pick also
   * still have to be patchable.
   */
  expenseCategoryId: idSchema.nullish().transform((value) => value ?? null),
  /** When the money left, which is not when somebody typed it in. */
  spentAt: isoDateTimeSchema,
  /**
   * Who was paid. Optional here, required by the expense category — see the
   * note on `createLiquidationLineSchema.payeeId`.
   */
  payeeId: idSchema.nullish().transform((value) => value ?? null),
  /**
   * The CLAIM already carrying this cost, when the crew paid for it out of cash
   * they hold. Omitted or null means the office paid it.
   *
   * THE CLAIM RATHER THAN THE ACCOUNT, so the cost this row defers to is one
   * that demonstrably exists. The account is derived from it server-side and
   * never sent: two fields that must agree are two fields that can disagree.
   *
   * DEFAULTING TO NULL IS DEFAULTING TO A COST, which is the direction that
   * fails loudly: an office-paid rebill wrongly linked drops a real cost off
   * the trip and nothing on any screen looks wrong, whereas a crew-paid one
   * left unlinked shows the same expense twice where somebody is reading both.
   */
  liquidationLineId: idSchema.nullish().transform((value) => value ?? null),
  referenceNumber: optionalText(80),
  receiptId: idSchema.nullish().transform((value) => value ?? null),
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

  /** The date the trip ran, from the paperwork — not `dispatchedAt`. */
  shipmentDate: z.string(),

  origin: z.string(),
  destination: z.string(),
  cargoDescription: z.string().nullable(),
  containerNumber: z.string().nullable(),

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
   * The stored commission chain predates a charge on the shipment, or a
   * correction to its rate chain, so the figures on screen no longer follow
   * from the ones beside them.
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

  /**
   * Where the trip stands with its client: the whole invoice, and what is
   * still outstanding against it.
   *
   * THE LIST'S FIGURES, and the mirror image of the two above — a table of
   * trips is exactly where "who still owes us" is asked, and answering it a
   * row at a time meant opening every trip in turn. Both come from
   * `receivablesOf`, which shares its arithmetic with
   * `ClientPaymentsService.summary`, so the pair on a row and the pair on that
   * trip's payments card are one computation rather than two that agree today.
   *
   * `balance` is `amountDue` less what has been collected, and is NEGATIVE on
   * an overpayment rather than clamped: money owed back is a fact somebody has
   * to act on.
   *
   * NULL MEANS NOT ANSWERED HERE — the detail endpoint leaves both null and
   * points at the payments card, which asks the same question with the
   * per-payment detail beside it. A CREW session is served nulls too, for the
   * reason every other revenue field is redacted; see `redactRevenueForCrew`.
   */
  amountDue: z.string().nullable().default(null),
  balance: z.string().nullable().default(null),
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
   * When the trip ran. Optional, defaulting to now on the server, because the
   * common case is booking a trip on the day it runs — and a date somebody has
   * to restate every time is a date somebody gets wrong.
   */
  shipmentDate: isoDateTimeSchema.nullish().transform((value) => value ?? null),

  /**
   * Snapshotted onto the shipment rather than read through the route, so
   * renaming a route later does not rewrite where old trips went.
   */
  origin: requiredText(160),
  destination: requiredText(160),
  cargoDescription: optionalText(400),

  /** The box on the trailer. Null for freight that is not containerised. */
  containerNumber: optionalText(40),

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

/**
 * The booking fields that still shut at DRAFT — the complement of the ones
 * `areBookingDetailsCorrectable` keeps open.
 *
 * Stated as the SMALLER, stricter list on purpose. A new field added to
 * `shipmentFields` and forgotten here would fall into the correctable set, so
 * the failure mode of forgetting is an editable field rather than a frozen one
 * — the direction a person can notice and fix, rather than one that silently
 * refuses a correction nobody understands.
 *
 * `grossRate`, `tpcRate` and `tpcAmount` are the rate chain, which has its own
 * correction route once the trip has left DRAFT; `thirdPartyId` is here because
 * the broker and the cut are one fact, so it goes with them. `truckId` has its
 * own endpoint with its own rule, and `cargoDescription` describes the load
 * rather than identifying the trip.
 */
export const DRAFT_ONLY_BOOKING_FIELDS = [
  'thirdPartyId',
  'truckId',
  'cargoDescription',
  'grossRate',
  'tpcRate',
  'tpcAmount',
] as const satisfies readonly (keyof UpdateShipmentInput)[];

/** Which of the DRAFT-only fields a patch actually touches, for the refusal. */
export function draftOnlyFieldsIn(input: UpdateShipmentInput): string[] {
  return DRAFT_ONLY_BOOKING_FIELDS.filter((field) => input[field] !== undefined);
}

/**
 * Correcting the rate chain after the trip has left DRAFT.
 *
 * ITS OWN ENDPOINT, not a relaxation of `updateShipmentSchema`, and the reason
 * is that the two obey different rules in three ways at once. The booking edit
 * is every dispatcher's and stops at DRAFT, because origin, cargo and the route
 * describe a trip that has not happened yet. This is a correction to an agreed
 * FIGURE — a broker who confirms a different cut, a rate typed with a zero
 * missing — it belongs to the administrator and the dispatch manager, and it
 * stays open until money has actually been paid against it. Widening the first
 * to cover the second would have given every dispatcher a lever on the
 * commission base of work already done.
 *
 * `thirdPartyId` is here because the broker and the cut are one fact: a TPC
 * cannot be set without a broker to owe it to, so a trip booked as direct
 * cannot be corrected without naming one. The other booking fields are not.
 */
export const updateRateChainSchema = shipmentFields
  .pick({ grossRate: true, thirdPartyId: true, tpcRate: true, tpcAmount: true })
  .partial();

export type UpdateRateChainInput = z.infer<typeof updateRateChainSchema>;

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

/**
 * Columns the shipment list may be ordered by.
 *
 * NAMED FOR THE COLUMN A READER SEES, not for the database field behind it:
 * `date` is the date the trip ran, which is `shipmentDate` and deliberately
 * not the row's `createdAt` — a trip typed up a week late belongs where the
 * paperwork puts it, and those two columns disagree precisely when it matters.
 * `client` orders by the client's name through the relation, because the
 * foreign key it is stored as sorts by nothing a human recognises.
 *
 * The set is closed rather than free text: an ordering clause built from an
 * arbitrary caller-supplied string is a way to ask the database about columns
 * the API never meant to expose.
 */
export const SHIPMENT_SORT_FIELDS = [
  'date',
  'number',
  'client',
  'container',
  'netRate',
  'status',
] as const;

export type ShipmentSortField = (typeof SHIPMENT_SORT_FIELDS)[number];

export const shipmentSortFieldSchema = z.enum(SHIPMENT_SORT_FIELDS);

export const shipmentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  // Query strings arrive as text, so coerce first, then check membership
  // against the code set rather than trusting the number.
  status: z.coerce.number().int().refine(isShipmentStatus, 'unknown shipment status').optional(),
  clientId: idSchema.optional(),
  staffId: idSchema.optional(),
  // Newest trip first, which is the list the office opens the screen to read.
  // Defaulted here rather than in the service so that the API's own default
  // and the web app's initial header state cannot drift apart.
  sort: shipmentSortFieldSchema.default('date'),
  direction: sortDirectionSchema.default('desc'),
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
