import { Injectable } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  money,
  ShipmentStatus,
  sum,
  toDecimalString,
  type GrossProfit,
  type ProfitAndLoss,
  type ProfitAndLossQuery,
  type ProfitAndLossShipment,
} from '@eztruckr/types';
import { OperationExpensesService } from '../operation-expenses/operation-expenses.service';
import { PrismaService } from '../prisma/prisma.service';
import { grossProfitOf } from '../shipments/gross-profit.service';
import { computationIsStale } from '../shipments/shipments.service';

/**
 * What the business made over a period.
 *
 * THE ONE REPORT THAT SPANS THE TWO HALVES OF THE MONEY MODEL. Everything else
 * in this system answers about one trip or about one ledger; this subtracts the
 * second from the first, which is the only level at which "what did we make in
 * August" has an answer. The reasoning behind every line — why `shipmentDate`
 * anchors a trip, why drafts are excluded, why the window is half-open, and why
 * overhead is subtracted once at the bottom rather than spread across trips —
 * is set out on `profitAndLossSchema`.
 *
 * THE TRIP FIGURES ARE THE TRIPS' OWN. Each shipment's revenue, cost and gross
 * profit come from `grossProfitOf`, the same function behind the card on
 * `/shipments/:id`, so a row in this report and that screen cannot disagree —
 * not because two implementations were checked against each other, but because
 * there is one. The alternative was a second four-term subtraction written
 * against SQL aggregates, which is the defect this codebase keeps finding.
 *
 * AND THE OVERHEAD LINE IS THE OVERHEAD SCREEN'S OWN, for the same reason:
 * `OperationExpensesService.summarise` is what `/operation-expenses` shows, so
 * the figure subtracted here is the figure that screen displays, category
 * breakdown included. A second `where` over `operation_expense` would have been
 * two filters that narrow differently the first time either is touched.
 *
 * READ IN BATCHES, NOT TRIP BY TRIP. `GrossProfitService.forShipment` costs
 * seven round trips, which is right for one trip and ruinous for a year of
 * them — a thousand-trip window would be seven thousand queries. This makes six
 * queries whatever the window's size: one for the shipments, four for their
 * charges and costs by `IN`, and one for the overhead. The arithmetic is then
 * pure and happens in memory.
 *
 * WHICH LEAVES ONE HONEST BOUND, stated rather than hidden: the whole window is
 * materialised. A period is read a month at a time and a month is hundreds of
 * trips, so this is the right shape today; a request for the company's entire
 * history is a table scan and will feel like one. The fix when that day comes
 * is a period close with stored totals — the row this system does not have yet,
 * and which `OperationExpense` wants first.
 */
@Injectable()
export class ProfitAndLossService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overhead: OperationExpensesService,
  ) {}

  async report(query: ProfitAndLossQuery): Promise<ProfitAndLoss> {
    const shipments = await this.prisma.client.shipment.findMany({
      where: this.tripFilter(query),
      select: {
        id: true,
        shipmentNumber: true,
        shipmentDate: true,
        grossRate: true,
        tpcAmount: true,
        netRate: true,
        commissionsComputedAt: true,
        rateChainUpdatedAt: true,
        client: { select: { name: true } },
      },
      // OLDEST FIRST, and ordered here rather than after the arithmetic: the
      // breakdown is read as the period's record, so it should run down the
      // calendar the way the shipments screen does. The id breaks ties — a
      // uuidv7, so it is both unique and minted in creation order — without
      // which two trips sharing a date could swap places between requests.
      orderBy: [{ shipmentDate: 'asc' }, { id: 'asc' }],
    });

    const shipmentIds = shipments.map((row) => row.id);

    // FOUR READS FOR ANY NUMBER OF TRIPS, and the overhead summary alongside
    // them because it depends on none of this. Every one goes through the
    // ordinary client, so the soft-delete filter applies exactly as it does on
    // a trip screen — a removed charge is absent from both or from neither.
    const [billable, additional, companyPaid, commissions, liquidations, operatingExpenses] =
      await Promise.all([
        this.prisma.client.billableExpense.findMany({
          where: { shipmentId: { in: shipmentIds } },
          select: {
            shipmentId: true,
            amount: true,
            billedAmount: true,
            liquidationId: true,
            // Carried for the staleness rule, which asks whether a charge moved
            // after commissions were computed. `isComputationStale` answers that
            // with a query per trip; here the rows are already in hand.
            updatedAt: true,
          },
        }),
        this.prisma.client.additionalCharge.findMany({
          where: { shipmentId: { in: shipmentIds } },
          select: { shipmentId: true, amount: true, updatedAt: true },
        }),
        this.prisma.client.companyPaidExpense.findMany({
          where: { shipmentId: { in: shipmentIds } },
          select: { shipmentId: true, amount: true },
        }),
        this.prisma.client.commission.findMany({
          where: { shipmentId: { in: shipmentIds } },
          select: { shipmentId: true, amount: true },
        }),
        this.prisma.client.liquidation.findMany({
          where: { shipmentId: { in: shipmentIds } },
          select: { shipmentId: true, status: true, totalLiquidated: true },
        }),
        // The overhead screen's own total, not a second read of the same table.
        this.overhead.summarise({ from: query.from, to: query.to }),
      ]);

    const billableBy = groupByShipment(billable);
    const additionalBy = groupByShipment(additional);
    const companyPaidBy = groupByShipment(companyPaid);
    const commissionsBy = groupByShipment(commissions);
    const liquidationsBy = groupByShipment(liquidations);

    const trips = shipments.map((shipment) => {
      const shipmentBillable = billableBy.get(shipment.id) ?? [];
      const shipmentAdditional = additionalBy.get(shipment.id) ?? [];

      const profit = grossProfitOf(shipment.id, {
        grossRate: shipment.grossRate,
        tpcAmount: shipment.tpcAmount,
        netRate: shipment.netRate,
        billable: shipmentBillable,
        additional: shipmentAdditional,
        companyPaid: companyPaidBy.get(shipment.id) ?? [],
        commissions: commissionsBy.get(shipment.id) ?? [],
        liquidations: liquidationsBy.get(shipment.id) ?? [],
        commissionsComputed: shipment.commissionsComputedAt !== null,
        // The SAME rule `isComputationStale` applies, answered off rows already
        // loaded rather than by two more queries per trip. What must not be
        // re-decided here is what stale MEANS — hence the shared predicate.
        commissionsStale: computationIsStale({
          commissionsComputedAt: shipment.commissionsComputedAt,
          rateChainUpdatedAt: shipment.rateChainUpdatedAt,
          chargesChangedSince: changedSince(
            shipment.commissionsComputedAt,
            shipmentBillable,
            shipmentAdditional,
          ),
        }),
      });

      return { shipment, profit };
    });

    // Summed from the per-trip figures, never re-derived from the rows. That is
    // what makes `byShipment` an audit of the total rather than a second view
    // of it: a reader adding the column up on paper gets the heading exactly.
    const revenue = sum(trips.map((trip) => trip.profit.revenue));
    const directCost = sum(trips.map((trip) => trip.profit.cost));
    const grossProfit = revenue.subtract(directCost);

    const overheadTotal = money(operatingExpenses.total);
    const netProfit = grossProfit.subtract(overheadTotal);

    // Already in the order it is reported in — the query ordered by date, and
    // `map` preserves that. No second sort here, because a list ordered in two
    // places is one that eventually disagrees with itself about ties.
    const byShipment: ProfitAndLossShipment[] = trips.map(({ shipment, profit }) => ({
      shipmentId: shipment.id,
      shipmentNumber: shipment.shipmentNumber,
      shipmentDate: shipment.shipmentDate.toISOString(),
      clientName: shipment.client?.name ?? null,
      revenue: profit.revenue,
      cost: profit.cost,
      grossProfit: profit.grossProfit,
      // The trip's OWN margin, passed through rather than divided again here.
      // `grossProfitOf` already computed it, nulls it on zero revenue, and is
      // the single definition of a margin in the system.
      margin: profit.margin,
      isProvisional: profit.isProvisional,
    }));

    const provisionalShipmentCount = trips.filter((trip) => trip.profit.isProvisional).length;

    return {
      from: query.from ?? null,
      to: query.to ?? null,

      grossRate: sumOf(trips, (profit) => profit.grossRate),
      thirdPartyCommission: sumOf(trips, (profit) => profit.thirdPartyCommission),
      netRate: sumOf(trips, (profit) => profit.netRate),
      billableExpenses: sumOf(trips, (profit) => profit.billableExpenses),
      additionalCharges: sumOf(trips, (profit) => profit.additionalCharges),
      revenue: toDecimalString(revenue),

      liquidatedExpenses: sumOf(trips, (profit) => profit.liquidatedExpenses),
      companyPaidExpenses: sumOf(trips, (profit) => profit.companyPaidExpenses),
      companyPaidBillableExpenses: sumOf(trips, (profit) => profit.companyPaidBillableExpenses),
      crewCommissions: sumOf(trips, (profit) => profit.crewCommissions),
      directCost: toDecimalString(directCost),

      grossProfit: toDecimalString(grossProfit),
      grossMargin: marginOf(grossProfit, revenue),

      operatingExpenses: operatingExpenses.total,
      operatingExpensesByCategory: operatingExpenses.byCategory,

      netProfit: toDecimalString(netProfit),
      netMargin: marginOf(netProfit, revenue),

      shipmentCount: trips.length,
      provisionalShipmentCount,
      operationExpenseCount: operatingExpenses.count,
      isProvisional: provisionalShipmentCount > 0,

      byShipment,
    };
  }

  // -------------------------------------------------------------------------

  /**
   * Which trips the period contains.
   *
   * ANCHORED ON `shipmentDate`, which is the column that states when the trip
   * RAN. `closedAt` would book August's freight into whatever month the
   * paperwork was finished, and `dispatchedAt` reports when somebody pressed a
   * button. The full argument is on `profitAndLossSchema`.
   *
   * THE UPPER BOUND IS EXCLUSIVE, matching the overhead half of this same
   * report exactly. The two are filtered on different columns of different
   * tables, so an interval that tiled on one and overlapped on the other would
   * double-count every month boundary's rent against freight counted once.
   *
   * DRAFTS ARE REFUSED BY STATUS, not by requiring a dispatch timestamp.
   * `dispatchedAt` is null on a trip booked before the feature existed and on
   * any imported history, and filtering on it would silently drop them from
   * every period they belong to. The status is the fact being asked about.
   */
  private tripFilter(query: ProfitAndLossQuery): Prisma.ShipmentWhereInput {
    return {
      status: { not: ShipmentStatus.DRAFT },
      ...(query.from || query.to
        ? {
            shipmentDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
  }
}

/**
 * Rows in hand, bucketed by the trip they belong to.
 *
 * One pass per table rather than a `filter` per trip, which would be quadratic
 * — a hundred trips against a hundred charges is ten thousand comparisons for
 * an answer a single grouping pass gives.
 */
function groupByShipment<T extends { shipmentId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();

  for (const row of rows) {
    const bucket = grouped.get(row.shipmentId);
    if (bucket) bucket.push(row);
    else grouped.set(row.shipmentId, [row]);
  }

  return grouped;
}

/** A charge on this trip moved after its commissions were computed. */
function changedSince(
  computedAt: Date | null,
  billable: readonly { updatedAt: Date }[],
  additional: readonly { updatedAt: Date }[],
): boolean {
  if (computedAt === null) return false;

  return (
    billable.some((row) => row.updatedAt > computedAt) ||
    additional.some((row) => row.updatedAt > computedAt)
  );
}

/**
 * One column of the per-trip breakdowns, added up.
 *
 * Summed from the trips' own decimal strings rather than from the database
 * rows, so every figure in the heading is the total of the column beneath it by
 * construction. `sum()` is the shared money helper, at 2dp throughout.
 */
function sumOf(
  trips: readonly { profit: GrossProfit }[],
  pick: (profit: GrossProfit) => string,
): string {
  return toDecimalString(sum(trips.map((trip) => pick(trip.profit))));
}

/**
 * A margin over revenue, to four places.
 *
 * THE SAME DEFINITION `GrossProfitService` USES, applied twice here — once to
 * gross profit and once to net. Both are presentational, both are computed
 * server-side so the browser does no float arithmetic on decimal strings, and
 * both are null on zero revenue rather than zero: a period that billed nothing
 * has no margin, and "0.0000" reads like a real one that happened to break
 * even.
 */
function marginOf(profit: ReturnType<typeof money>, revenue: ReturnType<typeof money>) {
  if (revenue.intValue === 0) return null;

  return (profit.value / revenue.value).toFixed(4);
}
