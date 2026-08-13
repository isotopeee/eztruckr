import { z } from 'zod';
import { disbursementModeSchema } from '../codes/disbursement-mode';
import {
  auditFieldsSchema,
  idSchema,
  isoDateTimeSchema,
  moneyStringSchema,
  optionalText,
} from './common';

/**
 * A release of cash to the crew.
 *
 * MANY PER SHIPMENT. There is no "the allowance" anywhere in this API: a trip
 * carries an initial advance and whatever top-ups the road demands, each its
 * own row with its own date and paper trail. Nothing edits a running total,
 * because a running total is what loses the first release when the second one
 * arrives.
 */
export const allowanceSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),

  /**
   * Which custodian's account this release is booked against — whose variance
   * it moves. A trip can carry one per cash holder, and until this existed
   * every release counted against a single blended total.
   */
  liquidationId: z.string(),
  custodianName: z.string().nullable(),

  /**
   * Who physically RECEIVED the cash. Deliberately independent of the account's
   * custodian: a helper can be handed ferry money the driver stays answerable
   * for, and flattening the two would lose one of the facts.
   */
  staffId: z.string(),
  staffName: z.string().nullable(),

  amount: z.string(),
  issuedAt: z.string(),
  remarks: z.string().nullable(),

  /** The user who handed the cash over, which need not be whoever typed it in. */
  releasedBy: z.string(),
  releasedByName: z.string().nullable(),

  disbursementMode: disbursementModeSchema,
  referenceNumber: z.string().nullable(),

  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),
});

export type Allowance = z.infer<typeof allowanceSchema>;

/**
 * A released amount is strictly positive.
 *
 * Zero is not a release, and a negative one is a settlement in the wrong table
 * — which is precisely the confusion the separate `Settlement` record exists to
 * prevent. Backed by the `allowance_amount_positive` CHECK.
 */
export const releasedMoneySchema = moneyStringSchema.refine(
  (value) => Number(value) > 0,
  'must be greater than zero',
);

export const issueAllowanceSchema = z.object({
  /**
   * Required: every release belongs to exactly one account. There is always at
   * least one to choose — a trip's first liquidation is created with the
   * shipment — so this never leaves the caller with nothing to name.
   */
  liquidationId: idSchema,
  staffId: idSchema,
  amount: releasedMoneySchema,

  /** Defaults to now, so a release can be recorded after the fact. */
  issuedAt: isoDateTimeSchema.nullish().transform((value) => value ?? null),

  disbursementMode: disbursementModeSchema,

  /**
   * Optional for every mode. A cash release in the yard has no reference and no
   * attachment, and requiring one only produces an invented reference that
   * reads like evidence.
   */
  referenceNumber: optionalText(80),
  receiptId: idSchema.nullish().transform((value) => value ?? null),

  /** Defaults to the acting user when the releaser is not named. */
  releasedBy: idSchema.nullish().transform((value) => value ?? null),

  remarks: optionalText(400),
});

export type IssueAllowanceInput = z.infer<typeof issueAllowanceSchema>;

/** Corrections to a release that has not yet been locked by an approval. */
export const updateAllowanceSchema = issueAllowanceSchema.partial();
export type UpdateAllowanceInput = z.infer<typeof updateAllowanceSchema>;

/**
 * The shipment's allowance position: every release, and the one figure that
 * matters downstream.
 *
 * `totalAdvanced` is the sum of the releases and nothing else — not the route's
 * standard allowance, not the largest release, not the first. It is the figure
 * the variance is measured against, so it is computed in one place and sent,
 * rather than left to each screen to add up.
 */
export const allowanceSummarySchema = z.object({
  shipmentId: z.string(),
  /** Every release on the trip, across all its accounts. */
  totalAdvanced: z.string(),
  releaseCount: z.number().int().nonnegative(),
  /** From the shipment's route, offered as a default for the first release. */
  routeStandardAllowance: z.string().nullable(),
  /**
   * At least one account is still open.
   *
   * A trip-level answer to a per-account question, so it is the permissive
   * half: it says whether the screen should offer the form at all. Which
   * particular account a release may be booked against is decided when one is
   * named, because approving the driver's liquidation must not stop cash being
   * released against the helper's.
   */
  canIssue: z.boolean(),
  allowances: z.array(allowanceSchema),
});

export type AllowanceSummary = z.infer<typeof allowanceSummarySchema>;
