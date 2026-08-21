import { Injectable } from '@nestjs/common';
import {
  isGrossProfitProvisional,
  LiquidationStatus,
  money,
  sum,
  toDecimalString,
  type GrossProfit,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { revenueAsStrings, shipmentRevenue } from './shipment-revenue';
import { ShipmentsService } from './shipments.service';

/**
 * What the trip made.
 *
 * DERIVED, NEVER STORED — the same decision as `recognisedCost`,
 * `commissionsStale` and `totalAdvanced`, and for the same reason: a
 * `grossProfit` column would be a second copy of a fact that six other tables
 * already determine, and every one of them can change after it was written.
 * Recomputing costs six counts; a stale column costs a wrong number in a
 * meeting.
 *
 * WHAT IS COUNTED, and the three things that are deliberately not, are set out
 * on `grossProfitSchema`. The short version of the omissions: an allowance is
 * a receivable rather than a cost, the gas deduction moves the commission base
 * and nothing else, and a settlement is cash squaring an advance. Counting any
 * of them would book the same peso twice.
 *
 * THE LIQUIDATION COUNTS AS IT RUNS, approved or not, and that is not the P&L
 * recognition rule being broken — it is a different question. What has POSTED
 * is `Liquidation.recognisedCost`, still zero until approval and still derived
 * from the status. What the trip has SPENT is this, and a manager watching a
 * trip in transit is asking the second one: money the crew have demonstrably
 * spent does not become less spent by waiting for a signature. The response
 * carries `costsRecognised` and `isProvisional` so the two are never confused.
 */
@Injectable()
export class GrossProfitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  async forShipment(shipmentId: string): Promise<GrossProfit> {
    const shipment = await this.shipments.load(shipmentId);

    const [income, companyPaid, commissions, liquidations, commissionsStale] = await Promise.all([
      // The revenue side, computed by the one function that also answers what
      // the CLIENT OWES — see `shipment-revenue.ts`. Every line that is
      // rebilled is revenue here; what it COST landed either on a company-paid
      // expense or on a liquidation line, so counting the billable amount on
      // both sides would double the cost, not net it out.
      shipmentRevenue(this.prisma, shipmentId, shipment.netRate),
      this.prisma.client.companyPaidExpense.findMany({
        where: { shipmentId },
        select: { amount: true },
      }),
      this.prisma.client.commission.findMany({
        where: { shipmentId },
        select: { amount: true },
      }),
      this.prisma.client.liquidation.findMany({
        where: { shipmentId },
        select: { status: true, totalLiquidated: true },
      }),
      this.shipments.isComputationStale(shipmentId),
    ]);

    const revenue = income.revenue;

    // EVERY ACCOUNT, not any one of them. A trip carries one liquidation per
    // cash holder, so reading a single row counted the driver's claims and
    // dropped the helper's — a cost understated by exactly one custodian's
    // spending, on the trips most likely to have a lot of it. The same
    // correction was already made where a trip closes; this was the copy of
    // the old one-account assumption that outlived it.
    //
    // THE RUNNING TOTAL, not just the approved one. `totalLiquidated` is
    // refreshed on every line change while a liquidation is open and frozen at
    // approval, so this one column is the right read in both states — and
    // reading it rather than re-summing the lines means an approved figure is
    // the figure that was actually approved.
    const liquidatedExpenses = sum(liquidations.map((row) => row.totalLiquidated));

    // APPROVED EVERYWHERE, or the cost is still moving. The driver squaring up
    // says nothing about the helper still holding change, and `every` on an
    // empty list is true — hence the guard, or a trip with no account at all
    // would report its costs as settled.
    const costsRecognised =
      liquidations.length > 0 &&
      liquidations.every((row) => row.status === LiquidationStatus.APPROVED);

    const companyPaidExpenses = sum(companyPaid.map((row) => row.amount));
    const crewCommissions = sum(commissions.map((row) => row.amount));
    const cost = liquidatedExpenses.add(companyPaidExpenses).add(crewCommissions);

    const grossProfit = revenue.subtract(cost);

    const basis = {
      costsRecognised,
      commissionsComputed: shipment.commissionsComputedAt !== null,
      commissionsStale,
    };

    return {
      shipmentId,

      // Every figure at 2dp, INCLUDING the three copied off the shipment.
      // `Decimal.toString()` drops trailing zeros, so a raw echo would put
      // "50000" beside a computed "48500.00" in one breakdown — and a column
      // of numbers that disagree about their own format is the first thing
      // that makes a reader doubt the arithmetic.
      grossRate: toDecimalString(money(shipment.grossRate)),
      thirdPartyCommission: toDecimalString(money(shipment.tpcAmount)),
      ...revenueAsStrings(income),

      liquidatedExpenses: toDecimalString(liquidatedExpenses),
      companyPaidExpenses: toDecimalString(companyPaidExpenses),
      crewCommissions: toDecimalString(crewCommissions),
      cost: toDecimalString(cost),

      grossProfit: toDecimalString(grossProfit),
      margin: marginOf(grossProfit, revenue),

      ...basis,
      isProvisional: isGrossProfitProvisional(basis),
    };
  }
}

/**
 * Gross profit over revenue, to four places.
 *
 * The ONE division in the money path, and it is presentational: nothing reads
 * this back and no stored figure derives from it. Done here rather than in the
 * browser so there is a single place where a margin is defined, and returned as
 * a string like every other number that crosses the wire.
 *
 * Null on zero revenue rather than zero. A trip that billed nothing has no
 * margin; reporting "0.0000" would read like a real one that happened to break
 * even, which is a different and much less alarming fact.
 */
function marginOf(grossProfit: ReturnType<typeof money>, revenue: ReturnType<typeof money>) {
  if (revenue.intValue === 0) return null;

  return (grossProfit.value / revenue.value).toFixed(4);
}
