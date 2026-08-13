import { z } from 'zod';
import { disbursementModeSchema } from '../codes/disbursement-mode';
import {
  auditFieldsSchema,
  cuidSchema,
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

  crewMemberId: z.string(),
  crewMemberName: z.string().nullable(),

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
  crewMemberId: cuidSchema,
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
  receiptId: cuidSchema.nullish().transform((value) => value ?? null),

  /** Defaults to the acting user when the releaser is not named. */
  releasedBy: cuidSchema.nullish().transform((value) => value ?? null),

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
  totalAdvanced: z.string(),
  releaseCount: z.number().int().nonnegative(),
  /** From the shipment's route, offered as a default for the first release. */
  routeStandardAllowance: z.string().nullable(),
  /** False once the trip's liquidation is approved and the variance is frozen. */
  canIssue: z.boolean(),
  allowances: z.array(allowanceSchema),
});

export type AllowanceSummary = z.infer<typeof allowanceSummarySchema>;
