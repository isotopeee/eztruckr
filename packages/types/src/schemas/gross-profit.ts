import { z } from 'zod';

/**
 * What the trip made, and out of what.
 *
 * Every figure here is a SUM OF ROWS THAT EXIST, not a stored total: there is
 * no `grossProfit` column for a late charge to leave stale, and adding one
 * would be the same defect as the cached `recovered` column that was taken off
 * `CrewDeduction`. The breakdown is returned alongside the answer because a
 * single number nobody can decompose is a number nobody can argue with.
 *
 * WHAT COUNTS AS REVENUE
 *
 *   netRate           the freight, after the broker's cut. `grossRate` and
 *                     `thirdPartyCommission` are shown so the cut is visible
 *                     as a line rather than silently netted away.
 *   billableExpenses  costs the company fronted and rebills. Revenue here; the
 *                     matching cost lands wherever the money actually went
 *                     out — a company-paid expense, or a liquidation line.
 *   additionalCharges fees with no underlying cost at all.
 *
 * WHAT COUNTS AS COST
 *
 *   liquidatedExpenses  what the crew have claimed so far — the RUNNING total
 *                       of the liquidation's lines, whether or not it has been
 *                       approved. `costsRecognised` says which it is.
 *   companyPaidExpenses what the office spent directly. Real from the moment
 *                       it is recorded — the money has already gone.
 *   crewCommissions     the crew's pay, from the computed rows.
 *
 * THE RUNNING LIQUIDATION COUNTS, AND THAT IS NOT THE RECOGNITION RULE BEING
 * BROKEN. Two different questions are being asked in two places, and each
 * still has exactly one answer:
 *
 *   `Liquidation.recognisedCost` — what has POSTED to the P&L. Zero until
 *   approval, derived from the status, and the reason a return-and-resubmit
 *   cycle cannot post two sets of costs.
 *
 *   `liquidatedExpenses` here — what the trip has SPENT so far. A manager
 *   looking at a trip in transit wants to know whether it is still earning,
 *   and excluding money the crew have demonstrably spent answers that
 *   question with a number that is simply too high. Waiting for approval to
 *   admit a ₱9,000 fuel claim does not make the ₱9,000 less gone.
 *
 * The two never disagree once approved, and while pending the response says so
 * through `costsRecognised` and `isProvisional` — so nobody reads a running
 * figure as a posted one.
 *
 * WHAT IS DELIBERATELY ABSENT, each for a reason that has bitten somebody:
 *
 *   ALLOWANCES are not a cost. Cash advanced is a receivable from the crew;
 *   counting it would charge the trip twice for every peso the crew then
 *   liquidated, and would charge it at all for money handed back.
 *
 *   THE GAS DEDUCTION is not a cost. It reduces the commission base and
 *   nothing else — actual fuel is recognised through the liquidation, so
 *   subtracting the deduction as well would book the fuel twice.
 *
 *   THE SETTLEMENT VARIANCE is not a cost. It is cash moving between the
 *   company and the crew to square an advance; the cost was whatever was
 *   liquidated, which is already counted above.
 */
export const grossProfitSchema = z.object({
  shipmentId: z.string(),

  // --- revenue -------------------------------------------------------------
  grossRate: z.string(),
  thirdPartyCommission: z.string(),
  netRate: z.string(),
  billableExpenses: z.string(),
  additionalCharges: z.string(),
  revenue: z.string(),

  // --- cost ----------------------------------------------------------------
  liquidatedExpenses: z.string(),
  companyPaidExpenses: z.string(),
  crewCommissions: z.string(),
  cost: z.string(),

  grossProfit: z.string(),

  /**
   * Gross profit over revenue, as a rate.
   *
   * PRESENTATIONAL ONLY, and the one division in the money path. Nothing reads
   * it back and no stored figure is derived from it; it exists so a manager
   * sees a percentage without the browser doing float arithmetic on two
   * decimal strings. Null when revenue is zero, rather than a zero that reads
   * like a real margin.
   */
  margin: z.string().nullable(),

  // --- what the number is standing on --------------------------------------
  /**
   * The liquidation is approved, so the crew's spending above is final.
   *
   * NOT whether it is counted — it always is. What this decides is whether the
   * amount can still move, which is why it feeds `isProvisional`.
   */
  costsRecognised: z.boolean(),
  commissionsComputed: z.boolean(),
  /** Commissions were computed before a charge on this trip last changed. */
  commissionsStale: z.boolean(),
  /** Any of the above is unsatisfied, so the figure will still move. */
  isProvisional: z.boolean(),
});

export type GrossProfit = z.infer<typeof grossProfitSchema>;

/** The three facts that decide whether the figure is finished. */
export interface GrossProfitBasis {
  costsRecognised: boolean;
  commissionsComputed: boolean;
  commissionsStale: boolean;
}

export function isGrossProfitProvisional(basis: GrossProfitBasis): boolean {
  return !basis.costsRecognised || !basis.commissionsComputed || basis.commissionsStale;
}

/**
 * Why the figure is not final yet, in the order a reader would ask.
 *
 * Declared here rather than in the card so the API's tests and the screen
 * agree on what "provisional" is claiming. A margin shown without these is a
 * number somebody will quote in a meeting.
 */
export function grossProfitCaveats(basis: GrossProfitBasis): string[] {
  const caveats: string[] = [];

  if (!basis.costsRecognised) {
    caveats.push(
      'The crew’s expenses are counted as they are claimed, but the liquidation is not approved — the amount can still change.',
    );
  }

  if (!basis.commissionsComputed) {
    caveats.push('Commissions have not been computed, so the crew’s pay is missing.');
  }

  if (basis.commissionsStale) {
    caveats.push('A charge changed after commissions were computed — recompute them.');
  }

  return caveats;
}
