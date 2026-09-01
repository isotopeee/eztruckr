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
 *   billableExpenses  what is REBILLED — the sum of `billedAmount`, not of
 *                     `amount`. Every rebill is revenue, whoever paid for it,
 *                     and only the part actually charged to the client is.
 *   additionalCharges fees with no underlying cost at all.
 *
 * WHAT WAS SPENT IS A DIFFERENT COLUMN FROM WHAT IS CHARGED, and reading the
 * wrong one here is the whole failure this function exists to prevent. A ₱2,000
 * permit rebilled at ₱1,500 owes the client ₱1,500; summing `amount` would
 * invoice them for a discount somebody agreed to give them.
 *
 * THE COST SPLIT IS COMPUTED HERE TOO, and it is the one thing in this file
 * that is not revenue. `companyPaidBillableExpenses` is what the OFFICE SPENT
 * on the rows with no liquidation on them — `amount` this time, because a cost
 * is what left, not what came back — and it is what `GrossProfitService`
 * charges as cost. It is computed here rather than by a second query over the
 * same table because the two reads would then have to agree about which rows
 * exist, and the soft-delete filter is exactly the sort of thing that stops
 * being applied to one of a pair. One read, one set of rows, two totals off it.
 *
 * A rebill the CREW paid for is deliberately absent from that subset: its cost
 * arrives as a liquidation line and is counted there, so charging it here as
 * well would book the same peso twice. Partial recovery needs nothing extra for
 * those — the liquidation counts the full spend and this counts the smaller
 * billed figure, so the shortfall falls out on its own.
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
  /** What is charged to the client for the rebills — their `billedAmount`. */
  billableExpenses: Money;
  additionalCharges: Money;
  /** The three above, added up. What the client owes for this trip. */
  revenue: Money;
  /**
   * What the company SPENT on the rebills it paid for itself, and so a cost
   * rather than part of the sum above. Not a subset of `billableExpenses` in
   * the arithmetic sense any more — that is billed, this is spent, and on a
   * partially recovered rebill this one is the larger. Not in
   * `revenueAsStrings`, because a client is not owed it a second time.
   */
  companyPaidBillableExpenses: Money;
}

export async function shipmentRevenue(
  prisma: PrismaService,
  shipmentId: string,
  netRate: { toString(): string },
): Promise<ShipmentRevenue> {
  const [billable, additional] = await Promise.all([
    prisma.client.billableExpense.findMany({
      where: { shipmentId },
      select: { amount: true, billedAmount: true, liquidationId: true },
    }),
    prisma.client.additionalCharge.findMany({ where: { shipmentId }, select: { amount: true } }),
  ]);

  // BILLED, not spent. The client owes what was agreed, not what it cost.
  const billableExpenses = sum(billable.map((row) => row.billedAmount));
  const additionalCharges = sum(additional.map((row) => row.amount));
  const net = money(netRate);

  return {
    netRate: net,
    billableExpenses,
    additionalCharges,
    revenue: net.add(billableExpenses).add(additionalCharges),

    // No link means nobody else recorded this money leaving, so this row is
    // the disbursement. The filter is on the link ALONE and not on, say,
    // whether the liquidation was approved: an unapproved account still
    // carries the line, and treating a pending one as company-paid would move
    // the same peso between two cost buckets as the crew filed paperwork.
    //
    // `amount`, not `billedAmount` — the cost is the whole outlay, including
    // the part the client was never asked for. Summing the billed figure here
    // would make an unrecovered peso disappear from the trip entirely rather
    // than land where it belongs, as margin the trip did not earn back.
    companyPaidBillableExpenses: sum(
      billable.filter((row) => row.liquidationId === null).map((row) => row.amount),
    ),
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
