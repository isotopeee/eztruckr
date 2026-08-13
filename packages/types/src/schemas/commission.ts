import { z } from 'zod';
import { commissionMethodSchema } from '../codes/commission-method';
import { crewRoleSchema } from '../codes/crew-role';
import { auditFieldsSchema } from './common';

/**
 * A computed commission, as the API returns it.
 *
 * Everything needed to check the figure by hand is on the row. That is
 * deliberate: a voucher or a dispute is answered from what was frozen at
 * computation, never by re-reading the rule, which may since have been edited,
 * deactivated or deleted.
 */
export const commissionSchema = auditFieldsSchema.extend({
  id: z.string(),
  shipmentId: z.string(),
  shipmentNumber: z.string().nullable(),
  staffId: z.string(),
  staffName: z.string().nullable(),

  /** The role actually filled on this trip, not a property of the person. */
  role: crewRoleSchema,
  appliedMethod: commissionMethodSchema,

  /**
   * Which rule produced this, as a frozen pair: the id traces, the name reads.
   *
   * The name is stored rather than joined because following the id gives the
   * rule as it stands today — a rename would otherwise relabel an old voucher.
   * Both null together on rows computed before the columns existed; they were
   * deliberately not backfilled, since resolution depends on rules and dates
   * as they were.
   */
  appliedRuleId: z.string().nullable(),
  appliedRuleName: z.string().nullable(),

  commissionableBase: z.string(),
  /**
   * Null where no meaningful rate exists — a fixed fee on a zero base. Null
   * means "not applicable", never "nothing was earned"; `amount` is always
   * authoritative.
   */
  appliedRate: z.string().nullable(),
  amount: z.string(),

  /** FORMULA only: the expression and the values it read, both frozen. */
  appliedFormulaExpression: z.string().nullable(),
  appliedFormulaFields: z.record(z.string(), z.string()).nullable(),

  computedAt: z.string(),
  /** Set once a payout run has paid this commission. */
  payoutLineId: z.string().nullable(),
});

export type Commission = z.infer<typeof commissionSchema>;

/**
 * What a computation run did, returned so the caller can show the chain that
 * produced the figures rather than just the figures.
 */
export const commissionComputationSchema = z.object({
  shipmentId: z.string(),
  /** The chain, each step rounded, in the order it was computed. */
  chain: z.object({
    netRate: z.string(),
    commissionableCharges: z.string(),
    grossForCommission: z.string(),
    appliedGasDeductionRate: z.string(),
    gasDeductionAmount: z.string(),
    commissionableBase: z.string(),
  }),
  commissions: z.array(commissionSchema),
  /** True when this run replaced an earlier, unpaid computation. */
  recomputed: z.boolean(),
  /** Set when computing also moved the shipment on. */
  statusAdvancedTo: z.number().int().nullable(),
});

export type CommissionComputation = z.infer<typeof commissionComputationSchema>;

/**
 * Whether the rules needed to pay a shipment's crew actually exist.
 *
 * Because there is no fallback rate, a missing or expired rule is a failure
 * waiting to happen at month-end. This is the proactive version of that
 * question, so a gap surfaces on a calm afternoon instead.
 */
export const ruleCoverageGapSchema = z.object({
  role: crewRoleSchema,
  roleLabel: z.string(),
  /** Human-readable scope, e.g. "any client, any route". */
  scope: z.string(),
  reason: z.string(),
  /** When the covering rule lapses, for a gap that has not opened yet. */
  lapsesAt: z.string().nullable(),
});

export type RuleCoverageGap = z.infer<typeof ruleCoverageGapSchema>;

export const ruleCoverageReportSchema = z.object({
  checkedAt: z.string(),
  /** How far ahead the check looked for lapses. */
  horizonDays: z.number().int(),
  gaps: z.array(ruleCoverageGapSchema),
});

export type RuleCoverageReport = z.infer<typeof ruleCoverageReportSchema>;
