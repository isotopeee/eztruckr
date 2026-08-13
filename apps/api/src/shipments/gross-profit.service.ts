import { Injectable } from '@nestjs/common';
import {
  isGrossProfitProvisional,
  LiquidationStatus,
  money,
  sum,
  toDecimalString,
  zero,
  type GrossProfit,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
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
 * THE LIQUIDATION IS ONLY A COST ONCE APPROVED, which is `isCostRecognised`
 * expressed as a query rather than re-derived here. Before approval the lines
 * are the crew's claim about money they were given, and the response says so
 * through `costsRecognised` rather than quietly folding a claim into a margin.
 */
@Injectable()
export class GrossProfitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipments: ShipmentsService,
  ) {}

  async forShipment(shipmentId: string): Promise<GrossProfit> {
    const shipment = await this.shipments.load(shipmentId);

    const [billable, additional, companyPaid, commissions, liquidation, commissionsStale] =
      await Promise.all([
        this.prisma.client.billableExpense.findMany({
          where: { shipmentId },
          select: { amount: true },
        }),
        this.prisma.client.additionalCharge.findMany({
          where: { shipmentId },
          select: { amount: true },
        }),
        this.prisma.client.companyPaidExpense.findMany({
          where: { shipmentId },
          select: { amount: true },
        }),
        this.prisma.client.commission.findMany({
          where: { shipmentId },
          select: { amount: true },
        }),
        this.prisma.client.liquidation.findFirst({
          where: { shipmentId },
          select: { status: true, totalLiquidated: true },
        }),
        this.shipments.isComputationStale(shipmentId),
      ]);

    // Every line that is rebilled is revenue here; what it COST landed either
    // on a company-paid expense or on a liquidation line, so counting the
    // billable amount on both sides would double the cost, not net it out.
    const billableExpenses = sum(billable.map((row) => row.amount));
    const additionalCharges = sum(additional.map((row) => row.amount));
    const netRate = money(shipment.netRate);
    const revenue = netRate.add(billableExpenses).add(additionalCharges);

    const costsRecognised = liquidation?.status === LiquidationStatus.APPROVED;
    const liquidatedExpenses =
      costsRecognised && liquidation ? money(liquidation.totalLiquidated) : zero();

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
      netRate: toDecimalString(netRate),
      billableExpenses: toDecimalString(billableExpenses),
      additionalCharges: toDecimalString(additionalCharges),
      revenue: toDecimalString(revenue),

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
