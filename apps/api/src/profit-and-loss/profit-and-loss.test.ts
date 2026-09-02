import {
  createPrismaClient,
  testUuid,
  withActor,
  withTriggersSuspended,
  type ExtendedPrismaClient,
} from '@eztruckr/db';
import { CrewRole, LiquidationStatus, ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OperationExpensesService } from '../operation-expenses/operation-expenses.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CompanyPaidExpensesService } from '../shipments/company-paid-expenses.service';
import { GrossProfitService } from '../shipments/gross-profit.service';
import { ShipmentChargesService } from '../shipments/shipment-charges.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { ProfitAndLossService } from './profit-and-loss.service';

/**
 * What the business made over a period.
 *
 * FIVE THINGS ARE WORTH A SUITE HERE, and none of them is the shape of the
 * response.
 *
 * The first is the claim the whole report rests on: its trip figures are the
 * TRIPS' OWN. Every total is asserted against `GrossProfitService` directly
 * rather than against a literal, because the failure this prevents is not a
 * wrong constant — it is the report and the trip screen drifting apart after
 * somebody edits one of them. A literal would keep passing through exactly that.
 *
 * The second is that overhead lands at the BOTTOM and nowhere else. An
 * operation expense must move the net line, leave gross profit untouched, and
 * leave every trip's own margin untouched field for field —
 * `operation-expenses.test.ts` asserts the third of those from the other side,
 * and this suite is where the first two live.
 *
 * The third is the date window, on BOTH halves at once. The trips are filtered
 * on `shipmentDate` and the overhead on `spentAt`, so a boundary that tiled on
 * one and overlapped on the other would double-count rent at every month end
 * against freight counted once — an error that reconciles to nothing and is
 * found in March.
 *
 * The fourth is which trips count. A DRAFT has not run, and counting one books
 * revenue for freight still sitting in the yard.
 *
 * The fifth is that a period is only as final as its trips. One provisional
 * shipment makes the whole month provisional, because a month is quoted as a
 * single number.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let profitAndLoss: ProfitAndLossService;
let shipments: ShipmentsService;
let grossProfits: GrossProfitService;
let charges: ShipmentChargesService;
let companyExpenses: CompanyPaidExpensesService;
let overhead: OperationExpensesService;

let adminId: string;
let staffId: string;

/** Reserved block: see the suite table in HANDOFF.md. */
const PREFIX = '0000000e-';
const id = (name: string) => testUuid('0000000e', name);

const CLIENT_ID = id('client');
const CATEGORY_ID = id('category');
const PAYEE_ID = id('payee');

/** August's trips. Two, so the report has something to add up. */
const AUGUST_TRIP = id('shipment-august');
const AUGUST_TRIP_2 = id('shipment-august-2');
/** Dated the first instant of September — the exclusive bound's own case. */
const BOUNDARY_TRIP = id('shipment-boundary');
/** Booked, never dispatched. Belongs to no period. */
const DRAFT_TRIP = id('shipment-draft');

const EVERY_TRIP = [AUGUST_TRIP, AUGUST_TRIP_2, BOUNDARY_TRIP, DRAFT_TRIP];

/**
 * A YEAR THIS SUITE RESERVES, the way it reserves a uuid block — and it needs
 * one more than `operation-expenses.test.ts` does, because this report
 * aggregates TWO global tables rather than one. An assertion about August is an
 * assertion about every shipment and every operation expense in a shared
 * database, so a single trip left behind by anything else makes it wrong.
 *
 * 2031, since 2029 is the overhead suite's. Nothing real is dated either.
 */
const AUGUST = { from: '2031-08-01T00:00:00.000Z', to: '2031-09-01T00:00:00.000Z' };
const SEPTEMBER = { from: '2031-09-01T00:00:00.000Z', to: '2031-10-01T00:00:00.000Z' };

/** Mid-month, so nothing in the suite sits on a bound by accident. */
const IN_AUGUST = '2031-08-15T02:00:00.000Z';

const CHILD_TABLES = [
  'company_paid_expense',
  'billable_expense',
  'additional_charge',
  'allowance',
  'commission',
];

async function cleanup(): Promise<void> {
  const shipmentIds = EVERY_TRIP.map((value) => `'${value}'`).join(', ');

  await withTriggersSuspended(prisma, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM "liquidation_line" WHERE "liquidationId" IN (SELECT id FROM "liquidation" WHERE "shipmentId" IN (${shipmentIds}))`,
    );

    // The charge tables before the liquidations they may point at.
    for (const table of CHILD_TABLES) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "shipmentId" IN (${shipmentIds})`);
    }

    await tx.$executeRawUnsafe(`DELETE FROM "liquidation" WHERE "shipmentId" IN (${shipmentIds})`);
    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE id IN (${shipmentIds})`);

    // BOTH RESERVED WINDOWS, by the column each table is actually queried on —
    // the same trick as the id block, on the axis the report reads. A row
    // created by hand against a seeded category, or a trip booked while
    // verifying against a running server, carries no prefix this suite owns and
    // would otherwise survive every clause above.
    await tx.$executeRawUnsafe(
      `DELETE FROM "operation_expense" WHERE "spentAt" >= '2031-01-01' AND "spentAt" < '2032-01-01'`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "shipment" WHERE "shipmentDate" >= '2031-01-01' AND "shipmentDate" < '2032-01-01'`,
    );

    await tx.$executeRawUnsafe(`DELETE FROM "expense_category" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "payee" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[profit-and-loss] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  const crew = await prisma.staff.findFirst({
    where: { firstName: 'Ricardo', lastName: 'Dela Cruz' },
  });
  if (!crew) throw new Error('Seed the database first: pnpm db:seed');
  staffId = crew.id;

  const service = { client: prisma } as unknown as PrismaService;
  shipments = new ShipmentsService(service);
  grossProfits = new GrossProfitService(service, shipments);
  charges = new ShipmentChargesService(service, shipments);
  companyExpenses = new CompanyPaidExpensesService(service, shipments);
  overhead = new OperationExpensesService(service);
  profitAndLoss = new ProfitAndLossService(service, overhead);
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!available) return;

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    await prisma.client.create({ data: { id: CLIENT_ID, name: `${PREFIX}Ayala Logistics` } });

    // Owned rather than seeded, and offered on BOTH sides: the suite files it
    // against a trip and against the overhead ledger in the same test.
    await prisma.expenseCategory.create({
      data: {
        id: CATEGORY_ID,
        name: `${PREFIX}Fuel`,
        requiresPayee: false,
        requiresReceipt: false,
        offeredOnTrips: true,
        offeredOnOverhead: true,
      },
    });
    await prisma.payee.create({ data: { id: PAYEE_ID, payeeType: 1, name: `${PREFIX}Petron` } });

    // 50,000 gross less a 5,000 broker cut leaves 45,000 net, twice — so a
    // total that silently counted one trip would still look like a real figure
    // rather than obviously half of one.
    await book(AUGUST_TRIP, { shipmentDate: IN_AUGUST });
    await book(AUGUST_TRIP_2, { shipmentDate: IN_AUGUST });
  });
});

async function book(
  shipmentId: string,
  over: { shipmentDate?: string; status?: number } = {},
): Promise<void> {
  await prisma.shipment.create({
    data: {
      id: shipmentId,
      shipmentNumber: shipmentId.toUpperCase(),
      status: over.status ?? ShipmentStatus.IN_TRANSIT,
      clientId: CLIENT_ID,
      driverId: staffId,
      origin: 'Manila',
      destination: 'Batangas',
      shipmentDate: new Date(over.shipmentDate ?? IN_AUGUST),
      grossRate: '50000.0000',
      tpcAmount: '5000.0000',
      netRate: '45000.0000',
    },
  });
}

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

const report = (window: { from?: string; to?: string } = AUGUST) =>
  act(() => profitAndLoss.report(window));

async function nextSequence(shipmentId: string): Promise<number> {
  const latest = await prisma.liquidation.findFirst({
    where: { shipmentId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true },
  });

  return (latest?.sequence ?? 0) + 1;
}

/** One custodian's account with a single line, as the liquidation service leaves it. */
async function addLiquidation(
  shipmentId: string,
  amount: string,
  status: number = LiquidationStatus.PENDING,
): Promise<string> {
  const liquidation = await act(async () =>
    prisma.liquidation.create({
      data: {
        shipmentId,
        sequence: await nextSequence(shipmentId),
        custodianId: staffId,
        status: LiquidationStatus.PENDING,
      },
    }),
  );

  // `async` + `await` INSIDE the scope, not a bare `act(() => prisma…)`. The
  // audit extension runs over AsyncLocalStorage and does not see a
  // `PrismaPromise` awaited outside `withActor`, so the loose form fails the
  // `_created_by_required` CHECK rather than doing anything visibly wrong.
  await act(async () =>
    prisma.liquidationLine.create({
      data: {
        liquidationId: liquidation.id,
        expenseCategoryId: CATEGORY_ID,
        payeeId: PAYEE_ID,
        amount,
        spentAt: new Date(IN_AUGUST),
      },
    }),
  );

  await prisma.liquidation.update({
    where: { id: liquidation.id },
    data: {
      totalLiquidated: amount,
      ...(status === LiquidationStatus.APPROVED
        ? {
            status: LiquidationStatus.APPROVED,
            submittedAt: new Date(),
            approvedAt: new Date(),
            approvedBy: adminId,
          }
        : {}),
    },
  });

  return liquidation.id;
}

function addCommission(shipmentId: string, amount: string) {
  return act(async () =>
    prisma.commission.create({
      data: {
        shipmentId,
        staffId,
        role: CrewRole.DRIVER,
        commissionableBase: '45000.0000',
        amount,
        appliedRate: '0.1500',
      },
    }),
  );
}

function recordOverhead(amount: string, spentAt: string) {
  return act(() =>
    overhead.add({
      expenseCategoryId: CATEGORY_ID,
      description: 'Office rent',
      amount,
      spentAt,
      payeeId: null,
      referenceNumber: null,
      receiptId: null,
    }),
  );
}

/**
 * A trip carrying one of everything the P&L reads.
 *
 * Deliberately not round numbers that could cancel: a 4,500 rebill billed at
 * 3,000 leaves 1,500 the company absorbed, which is the case where revenue and
 * cost read DIFFERENT columns of one row. A report that summed the wrong one
 * would still balance against itself and be wrong by exactly that gap.
 */
async function furnish(shipmentId: string): Promise<void> {
  await act(() =>
    charges.addAdditionalCharge(shipmentId, {
      description: 'Detention',
      amount: '2000.00',
      isCommissionable: false,
    }),
  );

  await act(() =>
    charges.addBillableExpense(shipmentId, {
      expenseCategoryId: CATEGORY_ID,
      description: 'Crane hire, rebilled short',
      amount: '4500.00',
      billedAmount: '3000.00',
      spentAt: IN_AUGUST,
      isCommissionable: false,
      payeeId: PAYEE_ID,
      liquidationLineId: null,
      referenceNumber: null,
      receiptId: null,
    }),
  );

  await act(() =>
    companyExpenses.add(shipmentId, {
      expenseCategoryId: CATEGORY_ID,
      description: 'Fleet card',
      amount: '6200.00',
      spentAt: IN_AUGUST,
      payeeId: PAYEE_ID,
      referenceNumber: null,
      receiptId: null,
    }),
  );

  await addLiquidation(shipmentId, '9000.00', LiquidationStatus.APPROVED);
  await addCommission(shipmentId, '6750.00');
  await markCommissionsComputed(shipmentId);
}

/**
 * Stamps the trip as computed, which is what the commission engine does and
 * what `commissionsComputed` reads.
 *
 * FROM THE DATABASE'S CLOCK, not the test runner's. Staleness compares this
 * against the `updatedAt` of rows Postgres timestamped itself, and the API and
 * the database are different machines here — a few milliseconds of skew the
 * wrong way would make a freshly computed trip report as stale, intermittently
 * and only on some hosts.
 */
async function markCommissionsComputed(shipmentId: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "shipment" SET "commissionsComputedAt" = now() WHERE id = '${shipmentId}'`,
  );
}

describe('the period’s trip figures', () => {
  it('are the trips’ own, summed — not a second computation of them', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);
    await furnish(AUGUST_TRIP_2);

    const [first, second] = await Promise.all([
      grossProfits.forShipment(AUGUST_TRIP),
      grossProfits.forShipment(AUGUST_TRIP_2),
    ]);

    const period = await report();

    // Asserted against the OTHER SERVICE rather than against literals, so the
    // test fails when the two drift apart rather than when either is edited.
    expect(period.revenue).toBe(add(first.revenue, second.revenue));
    expect(period.directCost).toBe(add(first.cost, second.cost));
    expect(period.grossProfit).toBe(add(first.grossProfit, second.grossProfit));

    // And every line of the breakdown, not just the three totals: a report that
    // agreed on the bottom line while misfiling a rebill between revenue and
    // cost would pass on the assertions above alone.
    expect(period.grossRate).toBe(add(first.grossRate, second.grossRate));
    expect(period.thirdPartyCommission).toBe(
      add(first.thirdPartyCommission, second.thirdPartyCommission),
    );
    expect(period.netRate).toBe(add(first.netRate, second.netRate));
    expect(period.billableExpenses).toBe(add(first.billableExpenses, second.billableExpenses));
    expect(period.additionalCharges).toBe(add(first.additionalCharges, second.additionalCharges));
    expect(period.liquidatedExpenses).toBe(
      add(first.liquidatedExpenses, second.liquidatedExpenses),
    );
    expect(period.companyPaidExpenses).toBe(
      add(first.companyPaidExpenses, second.companyPaidExpenses),
    );
    expect(period.companyPaidBillableExpenses).toBe(
      add(first.companyPaidBillableExpenses, second.companyPaidBillableExpenses),
    );
    expect(period.crewCommissions).toBe(add(first.crewCommissions, second.crewCommissions));

    expect(period.shipmentCount).toBe(2);
  });

  it('decompose: the breakdown adds up to the heading above it', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);
    await furnish(AUGUST_TRIP_2);

    const period = await report();

    // The property a reader checks on paper, and the one that makes the total
    // auditable rather than merely plausible.
    expect(period.revenue).toBe(
      add(period.netRate, period.billableExpenses, period.additionalCharges),
    );
    expect(period.directCost).toBe(
      add(
        period.liquidatedExpenses,
        period.companyPaidExpenses,
        period.companyPaidBillableExpenses,
        period.crewCommissions,
      ),
    );
    expect(period.grossProfit).toBe(subtract(period.revenue, period.directCost));

    expect(period.byShipment).toHaveLength(2);
    expect(add(...period.byShipment.map((trip) => trip.revenue))).toBe(period.revenue);
    expect(add(...period.byShipment.map((trip) => trip.cost))).toBe(period.directCost);
    expect(add(...period.byShipment.map((trip) => trip.grossProfit))).toBe(period.grossProfit);
  });

  it('name each trip, with the figures its own screen shows', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);

    const trip = await grossProfits.forShipment(AUGUST_TRIP);
    const period = await report();

    const row = period.byShipment.find((entry) => entry.shipmentId === AUGUST_TRIP);

    expect(row).toMatchObject({
      shipmentNumber: AUGUST_TRIP.toUpperCase(),
      clientName: `${PREFIX}Ayala Logistics`,
      revenue: trip.revenue,
      cost: trip.cost,
      grossProfit: trip.grossProfit,
      // The trip's OWN margin, not a second division here — against the other
      // service, so the column and the trip's card cannot round differently.
      margin: trip.margin,
      isProvisional: trip.isProvisional,
    });
    expect(row?.shipmentDate).toBe(IN_AUGUST);
    // Not null on a trip that billed something, or the assertion above would
    // pass just as well on two nulls.
    expect(row?.margin).not.toBeNull();
  });

  it('report no margin for a trip that billed nothing, rather than a zero', async () => {
    if (!available) return;

    // No rate, no charges — a trip with nothing on the revenue side at all.
    await prisma.shipment.update({
      where: { id: AUGUST_TRIP },
      data: { grossRate: '0.0000', tpcAmount: '0.0000', netRate: '0.0000' },
    });

    const row = (await report()).byShipment.find((entry) => entry.shipmentId === AUGUST_TRIP);

    expect(row?.revenue).toBe('0.00');
    expect(row?.margin).toBeNull();
  });

  it('are ordered oldest first, with the id breaking a shared date', async () => {
    if (!available) return;

    // A third trip, dated between the two the suite books together.
    await act(() => book(BOUNDARY_TRIP, { shipmentDate: '2031-08-20T02:00:00.000Z' }));
    await prisma.shipment.update({
      where: { id: AUGUST_TRIP_2 },
      data: { shipmentDate: new Date('2031-08-02T02:00:00.000Z') },
    });

    const period = await report();

    expect(period.byShipment.map((trip) => trip.shipmentId)).toEqual([
      AUGUST_TRIP_2, // 2 August
      AUGUST_TRIP, // 15 August
      BOUNDARY_TRIP, // 20 August
    ]);

    // Stated as the property rather than the sequence, so the claim survives
    // the fixtures being re-dated.
    const dates = period.byShipment.map((trip) => Date.parse(trip.shipmentDate));
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('keep a stable order when two trips share a date', async () => {
    if (!available) return;

    // Both already sit on IN_AUGUST, so only the id tiebreak separates them —
    // and it must give the same answer every time or a reader watching the
    // table would see two rows swap for no reason.
    const first = await report();
    const second = await report();

    expect(second.byShipment.map((trip) => trip.shipmentId)).toEqual(
      first.byShipment.map((trip) => trip.shipmentId),
    );
    expect(first.byShipment).toHaveLength(2);
  });
});

describe('overhead', () => {
  it('is subtracted once, at the bottom — never from a trip', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);

    const before = await report();
    const tripBefore = await grossProfits.forShipment(AUGUST_TRIP);

    await recordOverhead('12000.00', IN_AUGUST);

    const after = await report();
    const tripAfter = await grossProfits.forShipment(AUGUST_TRIP);

    // The trip did not move, field for field. This is the claim
    // `grossProfitSchema` makes about its deliberate absences, asserted from
    // the report's side: adding overhead to the company's books must not make
    // one shipment look less profitable.
    expect(tripAfter).toEqual(tripBefore);

    // Nor did the report's gross line, which is the same claim one level up.
    expect(after.grossProfit).toBe(before.grossProfit);
    expect(after.directCost).toBe(before.directCost);
    expect(after.revenue).toBe(before.revenue);

    // The net line did.
    expect(after.operatingExpenses).toBe('12000.00');
    expect(after.netProfit).toBe(subtract(after.grossProfit, '12000.00'));
    expect(after.netProfit).toBe(subtract(before.netProfit, '12000.00'));
    expect(after.operationExpenseCount).toBe(1);
  });

  it('is the overhead screen’s own total, category breakdown included', async () => {
    if (!available) return;

    await recordOverhead('12000.00', IN_AUGUST);
    await recordOverhead('3400.00', IN_AUGUST);

    const [period, ledger] = await Promise.all([report(), act(() => overhead.summarise(AUGUST))]);

    // Against the other service, not a literal — the two must not be able to
    // narrow differently, and only this comparison catches it if they start to.
    expect(period.operatingExpenses).toBe(ledger.total);
    expect(period.operationExpenseCount).toBe(ledger.count);
    expect(period.operatingExpensesByCategory).toEqual(ledger.byCategory);
    expect(period.operatingExpensesByCategory).toHaveLength(1);
    expect(period.operatingExpensesByCategory[0]).toMatchObject({
      expenseCategoryName: `${PREFIX}Fuel`,
      amount: '15400.00',
      count: 2,
    });
  });
});

describe('the date window', () => {
  it('is half-open on the trips: `from` counts, `to` does not', async () => {
    if (!available) return;

    await act(() => book(BOUNDARY_TRIP, { shipmentDate: SEPTEMBER.from }));

    // A trip dated the first instant of September is September's, not August's,
    // so consecutive months tile and no trip is counted in both.
    const august = await report(AUGUST);
    expect(august.byShipment.map((trip) => trip.shipmentId)).not.toContain(BOUNDARY_TRIP);
    expect(august.shipmentCount).toBe(2);

    const september = await report(SEPTEMBER);
    expect(september.byShipment.map((trip) => trip.shipmentId)).toEqual([BOUNDARY_TRIP]);
    expect(september.shipmentCount).toBe(1);
  });

  it('is half-open on the overhead too, on the same bound', async () => {
    if (!available) return;

    await recordOverhead('7000.00', AUGUST.from);
    await recordOverhead('9000.00', SEPTEMBER.from);

    // Both halves of the report tile identically. A trip and an expense dated
    // the same boundary instant land in the same month as each other.
    expect((await report(AUGUST)).operatingExpenses).toBe('7000.00');
    expect((await report(SEPTEMBER)).operatingExpenses).toBe('9000.00');
  });

  it('reports everything on the books when neither bound is given', async () => {
    if (!available) return;

    await act(() => book(BOUNDARY_TRIP, { shipmentDate: SEPTEMBER.from }));

    const everything = await report({});

    expect(everything.from).toBeNull();
    expect(everything.to).toBeNull();
    // The suite's own trips are in a shared database, so the claim is that the
    // unbounded window is a SUPERSET of a bounded one, not an exact count.
    expect(everything.byShipment.map((trip) => trip.shipmentId)).toContain(BOUNDARY_TRIP);
    expect(everything.shipmentCount).toBeGreaterThanOrEqual(3);
  });

  it('echoes the window back, because both bounds are optional', async () => {
    if (!available) return;

    const period = await report(AUGUST);

    expect(period.from).toBe(AUGUST.from);
    expect(period.to).toBe(AUGUST.to);
  });
});

describe('which trips count', () => {
  it('excludes a draft — nothing has run, so nothing is earned', async () => {
    if (!available) return;

    const before = await report();

    await act(() => book(DRAFT_TRIP, { status: ShipmentStatus.DRAFT }));

    const after = await report();

    // A booking typed twice at eight in the morning must not inflate August.
    expect(after.shipmentCount).toBe(before.shipmentCount);
    expect(after.revenue).toBe(before.revenue);
    expect(after.byShipment.map((trip) => trip.shipmentId)).not.toContain(DRAFT_TRIP);
  });

  it('includes a trip still in transit, at every status from dispatched on', async () => {
    if (!available) return;

    for (const status of [
      ShipmentStatus.DISPATCHED,
      ShipmentStatus.IN_TRANSIT,
      ShipmentStatus.DELIVERED,
      ShipmentStatus.PENDING_LIQUIDATION,
      ShipmentStatus.LIQUIDATED,
      ShipmentStatus.CLOSED,
    ]) {
      await prisma.shipment.update({ where: { id: AUGUST_TRIP }, data: { status } });

      const period = await report();
      expect(period.byShipment.map((trip) => trip.shipmentId)).toContain(AUGUST_TRIP);
    }
  });

  it('follows `shipmentDate`, so a trip corrected into another month moves', async () => {
    if (!available) return;

    expect((await report(AUGUST)).shipmentCount).toBe(2);
    expect((await report(SEPTEMBER)).shipmentCount).toBe(0);

    // The date the trip RAN, as it appears on the paperwork — correctable, and
    // the one column that decides which period owns the freight. Nothing about
    // when the row was typed or closed has moved.
    await prisma.shipment.update({
      where: { id: AUGUST_TRIP },
      data: { shipmentDate: new Date('2031-09-04T02:00:00.000Z') },
    });

    expect((await report(AUGUST)).shipmentCount).toBe(1);
    expect((await report(SEPTEMBER)).shipmentCount).toBe(1);
  });
});

describe('how final the figure is', () => {
  it('is provisional while any one trip is, and says how many', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);

    // The second trip has no liquidation and no commissions at all, so its own
    // figure is still moving — and one is enough.
    const period = await report();

    expect(period.provisionalShipmentCount).toBe(1);
    expect(period.isProvisional).toBe(true);
  });

  it('is final only when every trip is', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);
    await furnish(AUGUST_TRIP_2);

    const period = await report();

    expect(period.provisionalShipmentCount).toBe(0);
    expect(period.isProvisional).toBe(false);
    expect(period.byShipment.every((trip) => !trip.isProvisional)).toBe(true);
  });

  it('marks a trip provisional when a charge lands after its commissions', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);
    await furnish(AUGUST_TRIP_2);
    expect((await report()).isProvisional).toBe(false);

    // A late port fee falsifies the computed commission. The report must reach
    // the same verdict `isComputationStale` reaches on the trip screen —
    // answered here off rows already loaded rather than by a query per trip,
    // which is exactly why the rule is a shared predicate.
    await act(() =>
      charges.addAdditionalCharge(AUGUST_TRIP, {
        description: 'Port fee, discovered late',
        amount: '800.00',
        isCommissionable: true,
      }),
    );

    const trip = await grossProfits.forShipment(AUGUST_TRIP);
    const period = await report();

    expect(trip.commissionsStale).toBe(true);
    expect(period.provisionalShipmentCount).toBe(1);
    expect(period.isProvisional).toBe(true);
    expect(period.byShipment.find((row) => row.shipmentId === AUGUST_TRIP)?.isProvisional).toBe(
      true,
    );
  });
});

describe('the margins', () => {
  it('are gross and net over revenue, both to four places', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);
    await furnish(AUGUST_TRIP_2);
    await recordOverhead('10000.00', IN_AUGUST);

    const period = await report();

    expect(period.grossMargin).toBe(
      (Number(period.grossProfit) / Number(period.revenue)).toFixed(4),
    );
    expect(period.netMargin).toBe((Number(period.netProfit) / Number(period.revenue)).toFixed(4));

    // Overhead is in one of them and not the other, which is the whole reason
    // the report reports two.
    expect(period.netMargin).not.toBe(period.grossMargin);
  });

  it('are null on a period that billed nothing, never a zero that reads like a margin', async () => {
    if (!available) return;

    const empty = await report({
      from: '2031-02-01T00:00:00.000Z',
      to: '2031-03-01T00:00:00.000Z',
    });

    expect(empty.shipmentCount).toBe(0);
    expect(empty.revenue).toBe('0.00');
    expect(empty.grossMargin).toBeNull();
    expect(empty.netMargin).toBeNull();
    expect(empty.grossProfit).toBe('0.00');
    expect(empty.netProfit).toBe('0.00');
  });

  it('report a loss as a negative net, not as a floor at zero', async () => {
    if (!available) return;

    await furnish(AUGUST_TRIP);
    await furnish(AUGUST_TRIP_2);

    const trips = await report();

    // More overhead than the trips earned. A month that lost money says so.
    await recordOverhead(add(trips.grossProfit, '5000.00'), IN_AUGUST);

    const period = await report();

    expect(period.netProfit).toBe('-5000.00');
    expect(Number(period.netMargin)).toBeLessThan(0);
  });
});

/**
 * Decimal-string arithmetic for the assertions, at the money helper's precision.
 *
 * The tests add figures the API produced rather than re-deriving them from the
 * fixtures, so an assertion says "these two services agree" rather than "this
 * constant is still what somebody typed in 2026".
 */
function add(...values: string[]): string {
  return values.reduce((total, value) => total + Number(value), 0).toFixed(2);
}

function subtract(left: string, right: string): string {
  return (Number(left) - Number(right)).toFixed(2);
}
