import { money, sum, toDecimalString, type Money } from '@eztruckr/types';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * What the trip earned, and therefore what the client owes for it.
 *
 * ONE PLACE, BECAUSE IT IS ASKED FROM TWO. `GrossProfitService` asks it to work
 * out what the trip made; `ClientPaymentsService` asks it to work out what is
 * still outstanding. Those must be the same number — an invoice chased against
 * one figure and a margin reported against another is the kind of disagreement
 * nobody notices until a client does — and two spellings of a three-term sum is
 * exactly how they would drift apart.
 *
 * WHAT COUNTS, unchanged from the definition on `grossProfitSchema`:
 *
 *   netRate           the freight, after the broker's cut. The gross rate is
 *                     not what the company collects when a broker is involved.
 *   billableExpenses  costs the company fronted and rebills. Revenue here; the
 *                     matching cost lands wherever the money actually went out.
 *   additionalCharges fees with no underlying cost at all.
 *
 * A CLIENT PAYMENT IS NOT IN THIS SUM and must never be added to it. Revenue is
 * recognised when the trip runs; a payment is its collection. Counting one here
 * would both double the freight and make what a client owes depend on what they
 * have already paid.
 *
 * THE NET RATE IS PASSED IN rather than loaded, because both callers have
 * already loaded the shipment for their own reasons and a second read would buy
 * nothing but a chance for the two to disagree about which row they meant.
 */
export interface ShipmentRevenue {
  netRate: Money;
  billableExpenses: Money;
  additionalCharges: Money;
  /** The three above, added up. What the client owes for this trip. */
  revenue: Money;
}

export async function shipmentRevenue(
  prisma: PrismaService,
  shipmentId: string,
  netRate: { toString(): string },
): Promise<ShipmentRevenue> {
  const [billable, additional] = await Promise.all([
    prisma.client.billableExpense.findMany({ where: { shipmentId }, select: { amount: true } }),
    prisma.client.additionalCharge.findMany({ where: { shipmentId }, select: { amount: true } }),
  ]);

  const billableExpenses = sum(billable.map((row) => row.amount));
  const additionalCharges = sum(additional.map((row) => row.amount));
  const net = money(netRate);

  return {
    netRate: net,
    billableExpenses,
    additionalCharges,
    revenue: net.add(billableExpenses).add(additionalCharges),
  };
}

/**
 * The same breakdown as decimal strings, at 2dp.
 *
 * `Decimal.toString()` drops trailing zeros, so an unformatted echo would put
 * "50000" beside a computed "48500.00" in one breakdown — and a column of
 * numbers that disagree about their own format is the first thing that makes a
 * reader doubt the arithmetic.
 */
export function revenueAsStrings(revenue: ShipmentRevenue) {
  return {
    netRate: toDecimalString(revenue.netRate),
    billableExpenses: toDecimalString(revenue.billableExpenses),
    additionalCharges: toDecimalString(revenue.additionalCharges),
    revenue: toDecimalString(revenue.revenue),
  };
}
