import { money, multiplyByRate, sum, toDecimalString } from '@eztruckr/types';

/**
 * The commission rate chain, as pure arithmetic.
 *
 *   commissionableCharges = commissionable billable expenses + commissionable
 *                           additional charges
 *   grossForCommission    = netRate + commissionableCharges
 *   gasDeduction          = grossForCommission x gasDeductionRate
 *   commissionableBase    = grossForCommission - gasDeduction
 *
 * EVERY STEP ROUNDS. Each line above is a value the shipment stores, so each
 * one is rounded to 2dp before it feeds the next. Carrying unrounded
 * intermediates through the whole chain would produce a stored
 * commissionableBase that, multiplied by the stored rate, does not equal the
 * stored commission — and the figures on the screen would stop reconciling on
 * a calculator. currency.js rounds half-up at its configured precision, which
 * is what `money()` gives us.
 *
 * TWO THINGS THIS CHAIN IS NOT.
 *
 *   The gas deduction is not a cost. It reduces the commission base and
 *   nothing else. Actual fuel is recognised as cost through the liquidation,
 *   so treating this as a P&L line would count it twice.
 *
 *   `commissionableCharges` is a subset of the two charge totals, not a third
 *   category. Revenue counts every billable expense and additional charge;
 *   the commission base counts only the ones flagged commissionable.
 *
 * No database, no Prisma, no I/O — so the worked example in the brief can be
 * asserted directly against this.
 */

export interface ChargeLine {
  readonly amount: string;
  readonly isCommissionable: boolean;
}

export interface ChainInput {
  readonly netRate: string;
  readonly billableExpenses: readonly ChargeLine[];
  readonly additionalCharges: readonly ChargeLine[];
  /** The rate actually applied to this shipment, already resolved. */
  readonly gasDeductionRate: string;
}

export interface CommissionChain {
  /** Every billable expense, commissionable or not. Revenue, and also cost. */
  readonly billableExpensesTotal: string;
  /** Every additional charge, commissionable or not. Pure revenue. */
  readonly additionalChargesTotal: string;
  /** netRate + both totals above. */
  readonly totalRevenue: string;
  /** Only the lines flagged commissionable. */
  readonly commissionableCharges: string;
  readonly grossForCommission: string;
  readonly gasDeductionAmount: string;
  readonly commissionableBase: string;
}

function totalOf(lines: readonly ChargeLine[]): string {
  return toDecimalString(sum(lines.map((line) => line.amount)));
}

function commissionableTotalOf(lines: readonly ChargeLine[]): string {
  return totalOf(lines.filter((line) => line.isCommissionable));
}

export function computeCommissionChain(input: ChainInput): CommissionChain {
  const billableExpensesTotal = totalOf(input.billableExpenses);
  const additionalChargesTotal = totalOf(input.additionalCharges);

  const commissionableCharges = toDecimalString(
    sum([
      commissionableTotalOf(input.billableExpenses),
      commissionableTotalOf(input.additionalCharges),
    ]),
  );

  const grossForCommission = toDecimalString(sum([input.netRate, commissionableCharges]));

  const gasDeductionAmount = toDecimalString(
    multiplyByRate(grossForCommission, input.gasDeductionRate),
  );

  const commissionableBase = toDecimalString(
    money(grossForCommission).subtract(money(gasDeductionAmount)),
  );

  return {
    billableExpensesTotal,
    additionalChargesTotal,
    totalRevenue: toDecimalString(
      sum([input.netRate, billableExpensesTotal, additionalChargesTotal]),
    ),
    commissionableCharges,
    grossForCommission,
    gasDeductionAmount,
    commissionableBase,
  };
}

/**
 * The rate chain that precedes the commission chain: gross - TPC = net.
 *
 * A broker cut is agreed either as a percentage of gross or as a flat peso
 * figure. Which one applied is recorded by `appliedTpcRate` being set or null,
 * so a later change to the broker's standard percentage cannot rewrite what
 * this shipment actually paid.
 */
export interface RateChainInput {
  readonly grossRate: string;
  /** A multiplier such as 0.10. Null when the cut was a flat amount. */
  readonly tpcRate?: string | null;
  /** Used when there is no rate. Null or absent means a direct client. */
  readonly tpcAmount?: string | null;
}

export interface RateChain {
  readonly grossRate: string;
  readonly tpcAmount: string;
  readonly netRate: string;
  readonly appliedTpcRate: string | null;
}

export function computeRateChain(input: RateChainInput): RateChain {
  const grossRate = toDecimalString(money(input.grossRate));

  const tpcAmount =
    input.tpcRate === null || input.tpcRate === undefined
      ? toDecimalString(money(input.tpcAmount ?? '0'))
      : toDecimalString(multiplyByRate(grossRate, input.tpcRate));

  return {
    grossRate,
    tpcAmount,
    netRate: toDecimalString(money(grossRate).subtract(money(tpcAmount))),
    appliedTpcRate: input.tpcRate ?? null,
  };
}
