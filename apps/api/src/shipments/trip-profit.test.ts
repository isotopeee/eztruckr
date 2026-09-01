import { BadRequestException } from '@nestjs/common';
import {
  createPrismaClient,
  withActor,
  type ExtendedPrismaClient,
  testUuid,
  withTriggersSuspended,
} from '@eztruckr/db';
import { CrewRole, LiquidationStatus, ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LIQUIDATION_INCLUDE, toLiquidation } from '../liquidation/liquidation.service';
import type { PrismaService } from '../prisma/prisma.service';
import { CompanyPaidExpensesService } from './company-paid-expenses.service';
import { GrossProfitService } from './gross-profit.service';
import { ShipmentChargesService } from './shipment-charges.service';
import { ShipmentsService } from './shipments.service';

/**
 * Costs the company paid itself, and the gross profit they belong to.
 *
 * The two are tested together because they exist for each other: the P&L had a
 * hole where an office-paid cost should go, and gross profit is what made the
 * hole visible. The arithmetic assertions are deliberately exact — a breakdown
 * whose parts do not add up to its total is the one failure a reader of the
 * screen cannot detect for themselves.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let shipments: ShipmentsService;
let companyExpenses: CompanyPaidExpensesService;
let charges: ShipmentChargesService;
let grossProfits: GrossProfitService;

let adminId: string;
let clientId: string;
let staffId: string;
let fuelCategoryId: string;
let payeeId: string;

/**
 * This suite's OWN category, because the payee-requirement tests flip
 * `requiresPayee` back and forth.
 *
 * The seeded FUEL category is global master data that other suites read while
 * turbo runs them concurrently, and mutating shared master data mid-run is the
 * suspected cause of the one known flake in this repo. Owning the row removes
 * the question.
 */
let toggleCategoryId: string;

/** Not `itest-`: see the note in liquidation-lifecycle.test.ts. */
const PREFIX = '00000005-';
const id = (name: string) => testUuid('00000005', name);

/**
 * Well-formed, and belonging to no row.
 *
 * Ids are `uuid` columns now, so a placeholder like 'no-such-truck' no longer
 * means "matches nothing" — it fails the cast before any row is compared, and
 * the service's own not-found message never runs. A reserved block keeps this
 * distinguishable from every suite's fixtures.
 */
const ABSENT_ID = 'ffffffff-0000-7000-8000-000000000000';

const SHIPMENT_ID = id('shipment');

/**
 * A second trip, used only to prove a rebill cannot be pinned to an account on
 * one. Declared here rather than inside the test because `cleanup` has to know
 * about it: a shipment left behind holds the client its FK points at, and the
 * next run fails on a name collision instead of on whatever it was testing.
 */
const OTHER_SHIPMENT_ID = id('other-shipment');

const CHILD_TABLES = [
  'company_paid_expense',
  'billable_expense',
  'additional_charge',
  'allowance',
  'commission',
];

async function cleanup(): Promise<void> {
  const shipmentIds = [SHIPMENT_ID, OTHER_SHIPMENT_ID].map((value) => `'${value}'`).join(', ');

  await withTriggersSuspended(prisma, async (tx) => {
    // Matched through the shipment, not by id prefix: the services generate
    // cuids, so nothing below the shipment carries the prefix.
    await tx.$executeRawUnsafe(
      `DELETE FROM "liquidation_line" WHERE "liquidationId" IN (SELECT id FROM "liquidation" WHERE "shipmentId" IN (${shipmentIds}))`,
    );

    // The charge tables go BEFORE the liquidations they may point at: a
    // billable expense carries the account that owes its cost, and the
    // composite key refuses to let the account go first.
    for (const table of CHILD_TABLES) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "shipmentId" IN (${shipmentIds})`);
    }

    await tx.$executeRawUnsafe(`DELETE FROM "liquidation" WHERE "shipmentId" IN (${shipmentIds})`);

    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE id IN (${shipmentIds})`);
    await tx.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "expense_category" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[trip-profit] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  const crew = await prisma.staff.findFirst({
    where: { firstName: 'Ricardo', lastName: 'Dela Cruz' },
  });
  const fuel = await prisma.expenseCategory.findFirst({ where: { name: 'Fuel' } });
  // Seeded, like the crew and the FUEL category: nothing here mutates a payee,
  // so there is no reason to own one. Contrast `toggleCategoryId`, which these
  // tests do mutate and therefore create per test.
  const payee = await prisma.payee.findFirst({ where: { name: 'Petron Calamba' } });
  if (!crew || !fuel || !payee) throw new Error('Seed the database first: pnpm db:seed');
  staffId = crew.id;
  fuelCategoryId = fuel.id;
  payeeId = payee.id;

  const service = { client: prisma } as unknown as PrismaService;
  shipments = new ShipmentsService(service);
  companyExpenses = new CompanyPaidExpensesService(service, shipments);
  charges = new ShipmentChargesService(service, shipments);
  grossProfits = new GrossProfitService(service, shipments);
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!available) return;

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    await prisma.client.create({
      data: { id: id('client'), name: 'Profit Test Client' },
    });
    clientId = id('client');

    // Recreated per test, so a flipped toggle never leaks into the next one.
    const toggleCategory = await prisma.expenseCategory.create({
      data: {
        id: id('toggle-category'),
        name: 'Toggle (profit suite)',
        requiresReceipt: false,
      },
    });
    toggleCategoryId = toggleCategory.id;

    await prisma.shipment.create({
      data: {
        id: SHIPMENT_ID,
        shipmentNumber: id('SHP').toUpperCase(),
        status: ShipmentStatus.IN_TRANSIT,
        clientId,
        driverId: staffId,
        origin: 'Manila',
        destination: 'Batangas',
        // 50,000 gross with a 5,000 broker cut leaves 45,000 net.
        grossRate: '50000.0000',
        tpcAmount: '5000.0000',
        netRate: '45000.0000',
      },
    });
  });
});

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

/**
 * The FIELD-LEVEL complaints inside a validation failure.
 *
 * `badRequest()` leaves `error.message` as the generic 'Validation failed' and
 * puts the detail in the response body, so a plain `rejects.toThrow(/…/)`
 * matches the wrapper and passes no matter which field was actually wrong.
 * `liquidation-lifecycle.test.ts` carries the same helper for the same reason.
 */
async function validationErrors(
  fn: () => Promise<unknown>,
): Promise<{ path: string; message: string }[]> {
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return (error.getResponse() as { errors?: { path: string; message: string }[] }).errors ?? [];
  }

  throw new Error('expected the call to be refused, and it was not');
}

/** Moves the toggle on the category this suite owns. Never a seeded one. */
async function setCategoryRequiresPayee(categoryId: string, requiresPayee: boolean) {
  await act(() =>
    prisma.expenseCategory.update({ where: { id: categoryId }, data: { requiresPayee } }),
  );
}

async function setStatus(status: ShipmentStatus): Promise<void> {
  await prisma.shipment.update({ where: { id: SHIPMENT_ID }, data: { status } });
}

describe('recording a cost the company paid itself', () => {
  it('records it against the trip, with the day the money left', async () => {
    if (!available) return;

    const expense = await act(() =>
      companyExpenses.add(SHIPMENT_ID, {
        expenseCategoryId: fuelCategoryId,
        description: 'Fleet card, Petron Calamba',
        amount: '6200.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        payeeId,
        referenceNumber: null,
        receiptId: null,
      }),
    );

    expect(expense.amount).toBe('6200');
    expect(expense.expenseCategoryName).toBe('Fuel');
    expect(expense.spentAt).toBe('2026-08-11T00:00:00.000Z');
  });

  it('refuses a category that does not exist — an uncategorised cost is unreportable', async () => {
    if (!available) return;

    await expect(
      act(() =>
        companyExpenses.add(SHIPMENT_ID, {
          expenseCategoryId: ABSENT_ID,
          description: null,
          amount: '100.00',
          spentAt: '2026-08-11T00:00:00.000Z',
          payeeId,
          referenceNumber: null,
          receiptId: null,
        }),
      ),
    ).rejects.toThrow(/Validation failed/);
  });

  it('refuses a payee that does not exist', async () => {
    if (!available) return;

    const errors = await validationErrors(() =>
      act(() =>
        companyExpenses.add(SHIPMENT_ID, {
          expenseCategoryId: fuelCategoryId,
          description: null,
          amount: '100.00',
          spentAt: '2026-08-11T00:00:00.000Z',
          payeeId: ABSENT_ID,
          referenceNumber: null,
          receiptId: null,
        }),
      ),
    );

    expect(errors).toEqual([{ path: 'payeeId', message: `No payee with id ${ABSENT_ID}` }]);
  });

  it('refuses a missing payee when the category demands one', async () => {
    if (!available) return;

    await setCategoryRequiresPayee(toggleCategoryId, true);

    const errors = await validationErrors(() =>
      act(() =>
        companyExpenses.add(SHIPMENT_ID, {
          expenseCategoryId: toggleCategoryId,
          description: null,
          amount: '100.00',
          spentAt: '2026-08-11T00:00:00.000Z',
          payeeId: null,
          referenceNumber: null,
          receiptId: null,
        }),
      ),
    );

    // Names the category, so the person filling the form knows why THIS line
    // demands a payee when the previous one did not.
    expect(errors).toEqual([
      {
        path: 'payeeId',
        message: expect.stringMatching(
          /^Toggle \(profit suite\) expenses must record who was paid/,
        ),
      },
    ]);
  });

  it('accepts a missing payee when the category does not', async () => {
    if (!available) return;

    // The toll-booth case the toggle exists for.
    await setCategoryRequiresPayee(toggleCategoryId, false);

    const expense = await act(() =>
      companyExpenses.add(SHIPMENT_ID, {
        expenseCategoryId: toggleCategoryId,
        description: 'Toll, no vendor worth recording',
        amount: '20.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        payeeId: null,
        referenceNumber: null,
        receiptId: null,
      }),
    );

    expect(expense.payeeId).toBeNull();
    expect(expense.payeeRequired).toBe(false);
  });

  /**
   * THE REASON THE FLAG IS COPIED ONTO THE ROW rather than read from the
   * category.
   *
   * Flipping a category to required must not reach backwards and invalidate
   * rows recorded when it was optional — otherwise correcting a typo on a
   * year-old expense fails on a rule that did not exist when it was written.
   * The same freezing `appliedTpcRate` and `appliedMethod` do.
   */
  it('keeps the rule the row was written under when the category later changes', async () => {
    if (!available) return;

    await setCategoryRequiresPayee(toggleCategoryId, false);

    const expense = await act(() =>
      companyExpenses.add(SHIPMENT_ID, {
        expenseCategoryId: toggleCategoryId,
        description: 'Recorded while optional',
        amount: '20.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        payeeId: null,
        referenceNumber: null,
        receiptId: null,
      }),
    );

    await setCategoryRequiresPayee(toggleCategoryId, true);

    // Still readable, still says what governed it.
    const rows = await act(() => companyExpenses.list(SHIPMENT_ID));
    expect(rows).toEqual([
      expect.objectContaining({ id: expense.id, payeeRequired: false, payeeId: null }),
    ]);

    // And an edit that does not touch the payee is refused, because the row
    // would now be re-stamped under the category's current rule. That is the
    // honest outcome: the office changed the rule, and this row cannot meet it
    // without somebody saying who was paid.
    const errors = await validationErrors(() =>
      act(() => companyExpenses.update(SHIPMENT_ID, expense.id, { amount: '25.00' })),
    );

    expect(errors).toEqual([
      { path: 'payeeId', message: expect.stringContaining('must record who was paid') },
    ]);
  });

  /**
   * The pairing is a CHECK, not merely a service rule.
   *
   * Asserted with raw SQL because every TypeScript path already refuses it —
   * which is exactly why the database is worth checking. A rule enforced only
   * in the service layer is one import script away from a cost in somebody's
   * P&L that nobody can reconcile.
   */
  it('cannot store a required-but-missing payee, even bypassing the service', async () => {
    if (!available) return;

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "company_paid_expense"
          (id, "shipmentId", "expenseCategoryId", amount, "spentAt", "payeeRequired", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('no-payee')}', '${SHIPMENT_ID}', '${fuelCategoryId}', 100, now(), true, now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/company_paid_expense_payee_required/);
  });

  /**
   * THE POINT OF THIS BLOCK. A charge locks at LIQUIDATED, because a charge
   * feeds the commission base and a computed commission has to stay
   * reproducible. A company-paid expense feeds no commission at all, so the
   * only thing that should close it is the trip closing — a fuel invoice that
   * arrives a fortnight after the trip is exactly the record this has to
   * accept. Both halves are asserted so that "making it consistent" fails
   * loudly rather than quietly forbidding the invoice.
   */
  it('can still be recorded on a liquidated trip, where a charge cannot', async () => {
    if (!available) return;

    await setStatus(ShipmentStatus.LIQUIDATED);

    await expect(
      act(() =>
        charges.addAdditionalCharge(SHIPMENT_ID, {
          description: 'Detention',
          amount: '1000.00',
          isCommissionable: false,
        }),
      ),
    ).rejects.toThrow(/charges are closed/i);

    const expense = await act(() =>
      companyExpenses.add(SHIPMENT_ID, {
        expenseCategoryId: fuelCategoryId,
        description: 'Invoice that arrived late',
        amount: '3000.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        payeeId,
        referenceNumber: null,
        receiptId: null,
      }),
    );

    expect(expense.amount).toBe('3000');
  });

  it('stops at CLOSED, where the trip becomes part of the record', async () => {
    if (!available) return;

    await setStatus(ShipmentStatus.CLOSED);

    await expect(
      act(() =>
        companyExpenses.add(SHIPMENT_ID, {
          expenseCategoryId: fuelCategoryId,
          description: null,
          amount: '500.00',
          spentAt: '2026-08-11T00:00:00.000Z',
          payeeId,
          referenceNumber: null,
          receiptId: null,
        }),
      ),
    ).rejects.toThrow(/closed; its costs are now part of the record/i);
  });
});

/**
 * A billable expense records the same facts as a company-paid one.
 *
 * The two are one act of spending seen from opposite sides — rebilled, or not —
 * so what is worth knowing about it does not change with the side. These pin
 * the parity in the places it could quietly come apart: the payee rule, which
 * has to be resolved through the shared statement of it rather than a second
 * copy, and the CHECK that backs the frozen flag.
 */
describe('a billable expense carries what a company-paid one does', () => {
  it('records the date, the payee and the reference alongside the amount', async () => {
    if (!available) return;

    const expense = await act(() =>
      charges.addBillableExpense(SHIPMENT_ID, {
        expenseCategoryId: fuelCategoryId,
        description: 'Crane hire, rebilled',
        amount: '4500.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        isCommissionable: false,
        payeeId,
        liquidationId: null,
        referenceNumber: 'SI-88214',
        receiptId: null,
      }),
    );

    expect(expense.spentAt).toBe('2026-08-11T00:00:00.000Z');
    expect(expense.payeeId).toBe(payeeId);
    expect(expense.referenceNumber).toBe('SI-88214');
    // Frozen from the category — Fuel demands a payee — rather than read live.
    expect(expense.payeeRequired).toBe(true);
  });

  it('refuses a missing payee when the category demands one', async () => {
    if (!available) return;

    await setCategoryRequiresPayee(toggleCategoryId, true);

    const errors = await validationErrors(() =>
      act(() =>
        charges.addBillableExpense(SHIPMENT_ID, {
          expenseCategoryId: toggleCategoryId,
          description: null,
          amount: '100.00',
          spentAt: '2026-08-11T00:00:00.000Z',
          isCommissionable: false,
          payeeId: null,
          liquidationId: null,
          referenceNumber: null,
          receiptId: null,
        }),
      ),
    );

    expect(errors).toEqual([
      { path: 'payeeId', message: expect.stringContaining('must record who was paid') },
    ]);
  });

  /**
   * The case a company-paid expense cannot reach, because its category is
   * mandatory. With no category there is no rule to freeze, so the flag has to
   * come out false — the only value the CHECK accepts without a payee beside it.
   */
  it('freezes the rule false when there is no category to take one from', async () => {
    if (!available) return;

    const expense = await act(() =>
      charges.addBillableExpense(SHIPMENT_ID, {
        expenseCategoryId: null,
        description: 'Port charges, no category',
        amount: '900.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        isCommissionable: false,
        payeeId: null,
        liquidationId: null,
        referenceNumber: null,
        receiptId: null,
      }),
    );

    expect(expense.expenseCategoryId).toBeNull();
    expect(expense.payeeRequired).toBe(false);
  });

  it('cannot store a required-but-missing payee, even bypassing the service', async () => {
    if (!available) return;

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "billable_expense"
          (id, "shipmentId", "expenseCategoryId", amount, "billedAmount", "spentAt", "payeeRequired", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('billable-no-payee')}', '${SHIPMENT_ID}', '${fuelCategoryId}', 100, 100, now(), true, now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/billable_expense_payee_required/);
  });
});

describe('gross profit', () => {
  /**
   * One account's number on its trip, allocated the way the service allocates
   * it. A fixture cannot hard-code 1: these tests open several accounts on one
   * shipment on purpose — including two for the same person — and the unique
   * index on (shipmentId, sequence) refuses the second of any pair that guesses.
   */
  async function nextSequence(shipmentId: string): Promise<number> {
    const latest = await prisma.liquidation.findFirst({
      where: { shipmentId },
      orderBy: { sequence: 'desc' },
      select: { sequence: true },
    });

    return (latest?.sequence ?? 0) + 1;
  }

  /**
   * One custodian's account, with a single line on it.
   *
   * `totalLiquidated` is written alongside the line because the service reads
   * that column rather than re-summing — the same thing the liquidation
   * service does on every line change.
   */
  async function addLiquidation(custodianId: string | null, amount: string) {
    const liquidation = await act(async () =>
      prisma.liquidation.create({
        data: {
          shipmentId: SHIPMENT_ID,
          sequence: await nextSequence(SHIPMENT_ID),
          custodianId,
          status: LiquidationStatus.PENDING,
        },
      }),
    );

    await act(async () =>
      prisma.liquidationLine.create({
        data: {
          liquidationId: liquidation.id,
          expenseCategoryId: fuelCategoryId,
          payeeId,
          amount,
          spentAt: new Date('2026-08-11T00:00:00.000Z'),
        },
      }),
    );

    await prisma.liquidation.update({
      where: { id: liquidation.id },
      data: { totalLiquidated: amount },
    });

    return liquidation.id;
  }

  /** Approved with the history the database's CHECKs require to believe it. */
  async function approve(liquidationId: string): Promise<void> {
    await prisma.liquidation.update({
      where: { id: liquidationId },
      data: {
        status: LiquidationStatus.APPROVED,
        submittedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: adminId,
      },
    });
  }

  async function addCompanyExpense(amount: string): Promise<void> {
    await act(() =>
      companyExpenses.add(SHIPMENT_ID, {
        expenseCategoryId: fuelCategoryId,
        description: null,
        amount,
        spentAt: '2026-08-11T00:00:00.000Z',
        payeeId,
        referenceNumber: null,
        receiptId: null,
      }),
    );
  }

  /**
   * A rebill, and WHOSE money paid for it. Null is the office; an account id is
   * the crew, whose liquidation then carries the cost.
   */
  async function addBillableExpense(
    amount: string,
    liquidationId: string | null = null,
    billedAmount?: string,
  ) {
    return act(() =>
      charges.addBillableExpense(SHIPMENT_ID, {
        expenseCategoryId: fuelCategoryId,
        description: null,
        amount,
        billedAmount,
        spentAt: '2026-08-11T00:00:00.000Z',
        isCommissionable: false,
        payeeId,
        liquidationId,
        referenceNumber: null,
        receiptId: null,
      }),
    );
  }

  it('adds revenue up from the net rate, the rebills and the fees', async () => {
    if (!available) return;

    await act(() =>
      charges.addBillableExpense(SHIPMENT_ID, {
        // Uncategorised, which is still legal for a rebill and is the case
        // that freezes `payeeRequired` false with nothing to take a rule from.
        expenseCategoryId: null,
        description: 'Port charges, rebilled',
        amount: '2000.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        isCommissionable: false,
        payeeId: null,
        liquidationId: null,
        referenceNumber: null,
        receiptId: null,
      }),
    );
    await act(() =>
      charges.addAdditionalCharge(SHIPMENT_ID, {
        description: 'Extra drop',
        amount: '1500.00',
        isCommissionable: false,
      }),
    );

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    expect(profit.grossRate).toBe('50000.00');
    expect(profit.thirdPartyCommission).toBe('5000.00');
    expect(profit.netRate).toBe('45000.00');
    expect(profit.billableExpenses).toBe('2000.00');
    expect(profit.additionalCharges).toBe('1500.00');
    // 45,000 + 2,000 + 1,500
    expect(profit.revenue).toBe('48500.00');
  });

  it('counts a company-paid expense as cost the moment it is recorded', async () => {
    if (!available) return;

    await addCompanyExpense('6200.00');

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    expect(profit.companyPaidExpenses).toBe('6200.00');
    expect(profit.cost).toBe('6200.00');
    expect(profit.grossProfit).toBe('38800.00');
  });

  /**
   * THE REBILL USED TO BE FREE MONEY. A billable expense was counted as
   * revenue and nowhere else, so a ₱2,000 permit the company paid for and
   * recovered added ₱2,000 to the trip's profit — the margin of a business
   * that gets permits for nothing, and wrong on every trip carrying one.
   *
   * The row is the disbursement, not a pointer at a cost recorded elsewhere:
   * it carries the date, payee, reference and receipt a company-paid expense
   * carries, and no other table has the permit on it. So it belongs on both
   * sides, off the one `amount` column — which is what makes the netting exact
   * rather than approximately right.
   */
  it('charges a billable expense as cost as well as revenue, so a rebill nets to zero', async () => {
    if (!available) return;

    const before = await grossProfits.forShipment(SHIPMENT_ID);

    await addBillableExpense('2000.00');

    const after = await grossProfits.forShipment(SHIPMENT_ID);

    // Both sides moved, by the same figure, because it is the same figure.
    expect(after.billableExpenses).toBe('2000.00');
    expect(after.revenue).toBe('47000.00');
    expect(after.cost).toBe('2000.00');

    // And so the profit did not move at all.
    expect(before.grossProfit).toBe('45000.00');
    expect(after.grossProfit).toBe('45000.00');

    // The margin does move — the same profit spread over a larger revenue,
    // which is the honest read of a pass-through and the reason a rebill is
    // not a way to make a trip look better.
    expect(after.margin).toBe('0.9574');
  });

  /**
   * The rebill ADDS to the other costs. Counted on both sides it nets to zero
   * on its own, and a service that quietly used it in place of what the crew
   * or the office spent would net to zero there too — with a total nobody
   * could decompose back to the lines on the page.
   */
  it('adds the rebill to the other costs rather than standing in for them', async () => {
    if (!available) return;

    await addCompanyExpense('6200.00');
    await addBillableExpense('2000.00');
    await addLiquidation(staffId, '9000.0000');

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    // 9,000 claimed + 6,200 office + 2,000 rebilled, and nothing yet for the
    // commissions — the four terms `cost` is documented to decompose into.
    expect(profit.cost).toBe('17200.00');
    // 47,000 of revenue less 17,200 of cost.
    expect(profit.grossProfit).toBe('29800.00');
  });

  /**
   * THE OTHER HALF OF THE SAME MISTAKE. A rebill the CREW paid for out of cash
   * they hold is already a cost — it is a line on their liquidation, counted
   * with everything else they spent. Charging the rebill row as well would book
   * the same permit twice, which is what happens to any rule that reads the
   * table rather than the row.
   *
   * The link is what tells the two apart, so the two cases are asserted against
   * each other on one trip: same amount, same category, same payee, and only
   * `liquidationId` different.
   */
  it('does not charge a rebill the crew paid for — its cost is on the liquidation', async () => {
    if (!available) return;

    // The crew's account, carrying the permit they paid for out of their cash.
    const account = await addLiquidation(staffId, '2000.0000');
    await addBillableExpense('2000.00', account);

    const crewPaid = await grossProfits.forShipment(SHIPMENT_ID);

    // Revenue counts it like any other rebill — the client is billed either way.
    expect(crewPaid.billableExpenses).toBe('2000.00');
    expect(crewPaid.revenue).toBe('47000.00');

    // The cost is the liquidation line, ONCE. Not the line and the rebill.
    expect(crewPaid.liquidatedExpenses).toBe('2000.00');
    expect(crewPaid.companyPaidBillableExpenses).toBe('0.00');
    expect(crewPaid.cost).toBe('2000.00');
    expect(crewPaid.grossProfit).toBe('45000.00');

    // The same expense, same everything, paid by the office instead: now the
    // rebill row IS the record of the money leaving, so it is a cost.
    await addBillableExpense('2000.00');

    const both = await grossProfits.forShipment(SHIPMENT_ID);

    expect(both.billableExpenses).toBe('4000.00');
    expect(both.companyPaidBillableExpenses).toBe('2000.00');
    // 2,000 liquidated + 2,000 office-paid rebill. The crew's is still counted
    // once, through the liquidation.
    expect(both.cost).toBe('4000.00');
    expect(both.grossProfit).toBe('45000.00');
  });

  /**
   * The link decides the cost, so MOVING it moves the cost. A rebill recorded
   * as office-paid and corrected to crew-paid must stop being charged twice at
   * the moment of the correction, not at the next recompute of something else.
   */
  it('moves the cost when a rebill is corrected from office-paid to crew-paid', async () => {
    if (!available) return;

    const account = await addLiquidation(staffId, '2000.0000');
    const rebill = await addBillableExpense('2000.00');

    const miscounted = await grossProfits.forShipment(SHIPMENT_ID);

    // The permit counted twice: once on the crew's line, once on the rebill.
    expect(miscounted.cost).toBe('4000.00');

    await act(() =>
      charges.updateBillableExpense(SHIPMENT_ID, rebill.id, { liquidationId: account }),
    );

    const corrected = await grossProfits.forShipment(SHIPMENT_ID);

    expect(corrected.companyPaidBillableExpenses).toBe('0.00');
    expect(corrected.cost).toBe('2000.00');
    // Revenue never moved — the client is billed the permit either way.
    expect(corrected.revenue).toBe('47000.00');
  });

  /**
   * PARTIAL RECOVERY, which one `amount` column could not express at all. The
   * workaround was to type the billed figure as the cost, so a ₱2,000 permit
   * recovered at ₱1,500 was recorded as having cost ₱1,500 — the trip claimed
   * to have spent less than it did, and the ₱500 it absorbed vanished rather
   * than showing up as the margin it cost.
   */
  it('bills less than was paid, and absorbs the difference as cost', async () => {
    if (!available) return;

    await addBillableExpense('2000.00', null, '1500.00');

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    // The client owes what was AGREED, not what it cost.
    expect(profit.billableExpenses).toBe('1500.00');
    expect(profit.revenue).toBe('46500.00');

    // The trip spent the whole ₱2,000 — the discount does not un-spend it.
    expect(profit.companyPaidBillableExpenses).toBe('2000.00');
    expect(profit.cost).toBe('2000.00');

    // 45,000 of freight less the ₱500 nobody recovered.
    expect(profit.grossProfit).toBe('44500.00');
  });

  it('recovers the whole amount when no billed figure is given', async () => {
    if (!available) return;

    const line = await addBillableExpense('2000.00');

    // Stated on the row rather than left null, so nothing downstream has to
    // know that "missing" means "all of it".
    expect(line.amount).toBe('2000');
    expect(line.billedAmount).toBe('2000');

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    // Still the pass-through it always was: revenue and cost move together.
    expect(profit.billableExpenses).toBe('2000.00');
    expect(profit.companyPaidBillableExpenses).toBe('2000.00');
    expect(profit.grossProfit).toBe('45000.00');
  });

  /**
   * A CREW-PAID REBILL NEEDS NO EXTRA ARITHMETIC for a shortfall. The
   * liquidation counts the full spend and revenue counts the smaller billed
   * figure, so the absorbed part falls out of the subtraction — and this is the
   * case where a service tempted to compute the gap itself would count it
   * twice.
   */
  it('absorbs a shortfall on a crew-paid rebill through the liquidation', async () => {
    if (!available) return;

    const account = await addLiquidation(staffId, '2000.0000');
    await addBillableExpense('2000.00', account, '1500.00');

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    expect(profit.billableExpenses).toBe('1500.00');
    // Nothing on the rebill row, because the crew's line already has it.
    expect(profit.companyPaidBillableExpenses).toBe('0.00');
    expect(profit.liquidatedExpenses).toBe('2000.00');
    expect(profit.cost).toBe('2000.00');
    // The same ₱44,500 as the office-paid case — whose cash paid for it does
    // not change what the trip made.
    expect(profit.grossProfit).toBe('44500.00');
  });

  it('changes only what it is told to when the billed figure is patched', async () => {
    if (!available) return;

    const line = await addBillableExpense('2000.00');

    await act(() =>
      charges.updateBillableExpense(SHIPMENT_ID, line.id, { billedAmount: '1500.00' }),
    );

    const discounted = await grossProfits.forShipment(SHIPMENT_ID);

    expect(discounted.billableExpenses).toBe('1500.00');
    // The cost did not move with it. Correcting a deal is not re-spending.
    expect(discounted.companyPaidBillableExpenses).toBe('2000.00');

    // And the reverse: correcting the cost leaves the agreed price alone,
    // which is the failure a service deriving one from the other would cause.
    await act(() => charges.updateBillableExpense(SHIPMENT_ID, line.id, { amount: '2400.00' }));

    const costlier = await grossProfits.forShipment(SHIPMENT_ID);

    expect(costlier.billableExpenses).toBe('1500.00');
    expect(costlier.companyPaidBillableExpenses).toBe('2400.00');
    expect(costlier.grossProfit).toBe('44100.00');
  });

  it('refuses a rebill pinned to an account on another trip', async () => {
    if (!available) return;

    const otherShipment = await act(async () =>
      prisma.shipment.create({
        data: {
          id: OTHER_SHIPMENT_ID,
          shipmentNumber: 'SH-PROFIT-OTHER',
          clientId,
          origin: 'Manila',
          destination: 'Cebu',
          grossRate: '1000.0000',
          tpcAmount: '0.0000',
          netRate: '1000.0000',
        },
      }),
    );

    const foreign = await act(async () =>
      prisma.liquidation.create({
        data: {
          shipmentId: otherShipment.id,
          sequence: await nextSequence(otherShipment.id),
          status: LiquidationStatus.PENDING,
        },
      }),
    );

    // Asserted on the FIELD, not just on "Validation failed". The composite key
    // would refuse this row anyway; the reason the service checks first is to
    // say which input was wrong, and a test that only proved it threw would
    // pass just as happily on a raw constraint violation surfacing as a 500.
    const errors = await validationErrors(() => addBillableExpense('2000.00', foreign.id));

    expect(errors).toEqual([expect.objectContaining({ path: 'liquidationId' })]);
  });

  /**
   * The crew's spending counts AS IT IS CLAIMED, not from approval.
   *
   * A manager looking at a trip in transit is asking whether it is still
   * earning, and a ₱9,000 fuel claim does not become less spent by waiting for
   * a signature — excluding it answers that question with a number that is
   * simply too high. What approval changes is whether the figure can still
   * move, which `costsRecognised` reports and `isProvisional` acts on.
   */
  it('counts the running liquidation, and flags that it is not yet approved', async () => {
    if (!available) return;

    const liquidation = await act(async () =>
      prisma.liquidation.create({
        data: {
          shipmentId: SHIPMENT_ID,
          sequence: await nextSequence(SHIPMENT_ID),
          status: LiquidationStatus.PENDING,
        },
      }),
    );

    await act(async () =>
      prisma.liquidationLine.create({
        data: {
          liquidationId: liquidation.id,
          expenseCategoryId: fuelCategoryId,
          payeeId,
          amount: '9000.0000',
          spentAt: new Date('2026-08-11T00:00:00.000Z'),
        },
      }),
    );

    await prisma.liquidation.update({
      where: { id: liquidation.id },
      data: { totalLiquidated: '9000.0000' },
    });

    const pending = await grossProfits.forShipment(SHIPMENT_ID);

    expect(pending.liquidatedExpenses).toBe('9000.00');
    expect(pending.grossProfit).toBe('36000.00');
    // Counted, but not settled — and the response has to say which.
    expect(pending.costsRecognised).toBe(false);
    expect(pending.isProvisional).toBe(true);

    // Two CHECKs have to be satisfied to write an approval, and both are
    // stating something true about how a liquidation gets there: it has an
    // approver (`..._approved_at_matches_status`) and it was submitted first
    // (`..._submitted_at_matches_status`). The database refuses to let even a
    // test invent a row with a history that could not have happened.
    await prisma.liquidation.update({
      where: { id: liquidation.id },
      data: {
        status: LiquidationStatus.APPROVED,
        submittedAt: new Date(),
        approvedAt: new Date(),
        approvedBy: adminId,
      },
    });

    const approved = await grossProfits.forShipment(SHIPMENT_ID);

    // The figure does not jump on approval — it was already right. All that
    // changes is that it has stopped being able to move.
    expect(approved.liquidatedExpenses).toBe('9000.00');
    expect(approved.grossProfit).toBe('36000.00');
    expect(approved.costsRecognised).toBe(true);
  });

  /**
   * THE BUG THIS SUITE COULD NOT SEE. Every other case here builds one
   * liquidation, which is what a trip used to have; the service read one row
   * with `findFirst` and stayed correct for exactly as long as that held. A
   * trip now carries an account per cash holder, so the read silently dropped
   * every account but one — understating cost, overstating profit, and doing it
   * worst on the long trips that put a second custodian on the truck.
   *
   * Two accounts, because one is what hid it.
   */
  it('counts every custodian’s account, not just the first', async () => {
    if (!available) return;

    // An account nobody was ever named to, and the driver's. Both hold cash;
    // both spent it.
    const unassigned = await addLiquidation(null, '9000.0000');
    const driver = await addLiquidation(staffId, '4000.0000');

    const both = await grossProfits.forShipment(SHIPMENT_ID);

    expect(both.liquidatedExpenses).toBe('13000.00');
    expect(both.grossProfit).toBe('32000.00');
    expect(both.costsRecognised).toBe(false);

    // One custodian squaring up settles nothing on its own: the driver's
    // paperwork says nothing about the cash still out on the other account.
    await approve(unassigned);

    const halfApproved = await grossProfits.forShipment(SHIPMENT_ID);

    expect(halfApproved.liquidatedExpenses).toBe('13000.00');
    expect(halfApproved.costsRecognised).toBe(false);
    expect(halfApproved.isProvisional).toBe(true);

    await approve(driver);

    const settled = await grossProfits.forShipment(SHIPMENT_ID);

    // Again the figure does not move on approval — only its standing does.
    expect(settled.liquidatedExpenses).toBe('13000.00');
    expect(settled.grossProfit).toBe('32000.00');
    expect(settled.costsRecognised).toBe(true);
  });

  /**
   * A trip with no account at all has not settled its costs — it has no costs
   * to settle. `every` on an empty list is true, so this is the case that says
   * the guard in front of it is load-bearing.
   */
  it('does not call an account-less trip’s costs recognised', async () => {
    if (!available) return;

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    expect(profit.liquidatedExpenses).toBe('0.00');
    expect(profit.costsRecognised).toBe(false);
  });

  /**
   * THE LINE THIS CHANGE MUST NOT CROSS. Counting the running liquidation in a
   * management figure is a different question from posting cost to the P&L,
   * and each still has exactly one answer. If somebody later "simplifies" the
   * two into one, `recognisedCost` starts reporting unapproved spending as
   * posted — and the guarantee that a return-and-resubmit cycle cannot post
   * two sets of costs goes with it.
   */
  it('does not make the unapproved spending count as recognised P&L cost', async () => {
    if (!available) return;

    const liquidation = await act(async () =>
      prisma.liquidation.create({
        data: {
          shipmentId: SHIPMENT_ID,
          sequence: await nextSequence(SHIPMENT_ID),
          status: LiquidationStatus.PENDING,
          totalLiquidated: '9000.0000',
        },
      }),
    );

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    // Through the real serialiser, not by re-deriving the rule here — the
    // point is that the shipped code answers the two questions differently.
    const recognised = toLiquidation(
      await prisma.liquidation.findFirstOrThrow({
        where: { id: liquidation.id },
        include: LIQUIDATION_INCLUDE,
      }),
    ).recognisedCost;

    expect(profit.liquidatedExpenses).toBe('9000.00');
    expect(recognised).toBe('0.00');
  });

  /**
   * The exclusion that costs money if it is ever "fixed". An allowance is cash
   * ADVANCED — a receivable from the crew, cleared by the liquidation.
   * Counting it would charge the trip for every peso twice: once when handed
   * over and again when liquidated, and once even for money handed straight
   * back.
   */
  it('does not count an allowance as a cost', async () => {
    if (!available) return;

    const before = await grossProfits.forShipment(SHIPMENT_ID);

    // Booked against an account, because every release now is: an allowance
    // with no liquidation is cash with nobody answerable for it.
    const account = await act(async () =>
      prisma.liquidation.create({
        data: { shipmentId: SHIPMENT_ID, sequence: await nextSequence(SHIPMENT_ID) },
      }),
    );

    await act(async () =>
      prisma.allowance.create({
        data: {
          shipmentId: SHIPMENT_ID,
          liquidationId: account.id,
          staffId,
          amount: '12000.0000',
          releasedBy: adminId,
          disbursementMode: 1,
        },
      }),
    );

    const after = await grossProfits.forShipment(SHIPMENT_ID);

    expect(after.cost).toBe(before.cost);
    expect(after.grossProfit).toBe(before.grossProfit);
  });

  /**
   * The other exclusion with teeth. The gas deduction lowers the commission
   * BASE and nothing else — the actual fuel is recognised through the
   * liquidation or as a company-paid expense, so subtracting the deduction as
   * well would book the fuel a second time.
   */
  it('does not subtract the gas deduction, which is a commission lever not a cost', async () => {
    if (!available) return;

    await addCompanyExpense('6200.00');

    await prisma.shipment.update({
      where: { id: SHIPMENT_ID },
      data: {
        appliedGasDeductionRate: '0.2500',
        gasDeductionAmount: '11250.0000',
        commissionableBase: '33750.0000',
      },
    });

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    // Cost is the fuel invoice alone. 45,000 - 6,200.
    expect(profit.cost).toBe('6200.00');
    expect(profit.grossProfit).toBe('38800.00');
  });

  it('counts the crew’s pay, and reports when it has not been computed', async () => {
    if (!available) return;

    const missing = await grossProfits.forShipment(SHIPMENT_ID);
    expect(missing.crewCommissions).toBe('0.00');
    expect(missing.commissionsComputed).toBe(false);

    await act(async () =>
      prisma.commission.create({
        data: {
          shipmentId: SHIPMENT_ID,
          staffId,
          role: CrewRole.DRIVER,
          commissionableBase: '45000.0000',
          amount: '6750.0000',
          appliedRate: '0.1500',
        },
      }),
    );

    await prisma.shipment.update({
      where: { id: SHIPMENT_ID },
      data: { commissionsComputedAt: new Date() },
    });

    const computed = await grossProfits.forShipment(SHIPMENT_ID);

    expect(computed.crewCommissions).toBe('6750.00');
    expect(computed.commissionsComputed).toBe(true);
    expect(computed.grossProfit).toBe('38250.00');
  });

  it('reports a margin, and no margin at all rather than zero when nothing was billed', async () => {
    if (!available) return;

    const earning = await grossProfits.forShipment(SHIPMENT_ID);
    // 45,000 profit on 45,000 revenue, nothing spent yet.
    expect(earning.margin).toBe('1.0000');

    await prisma.shipment.update({
      where: { id: SHIPMENT_ID },
      data: { grossRate: '0.0000', tpcAmount: '0.0000', netRate: '0.0000' },
    });

    const free = await grossProfits.forShipment(SHIPMENT_ID);

    // Not "0.0000", which would read like a real margin that broke even.
    expect(free.margin).toBeNull();
  });

  it('is only final once the liquidation is approved and commissions are computed', async () => {
    if (!available) return;

    const liquidation = await act(async () =>
      prisma.liquidation.create({
        data: {
          shipmentId: SHIPMENT_ID,
          sequence: await nextSequence(SHIPMENT_ID),
          status: LiquidationStatus.APPROVED,
          submittedAt: new Date(),
          approvedAt: new Date(),
          approvedBy: adminId,
        },
      }),
    );

    await act(async () =>
      prisma.commission.create({
        data: {
          shipmentId: SHIPMENT_ID,
          staffId,
          role: CrewRole.DRIVER,
          commissionableBase: '45000.0000',
          amount: '6750.0000',
          appliedRate: '0.1500',
        },
      }),
    );

    await prisma.shipment.update({
      where: { id: SHIPMENT_ID },
      data: { commissionsComputedAt: new Date() },
    });

    const profit = await grossProfits.forShipment(SHIPMENT_ID);

    expect(liquidation.status).toBe(LiquidationStatus.APPROVED);
    expect(profit.isProvisional).toBe(false);
  });
});
