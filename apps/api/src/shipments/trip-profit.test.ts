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

const CHILD_TABLES = [
  'company_paid_expense',
  'billable_expense',
  'additional_charge',
  'allowance',
  'commission',
];

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    // Matched through the shipment, not by id prefix: the services generate
    // cuids, so nothing below the shipment carries the prefix.
    await tx.$executeRawUnsafe(
      `DELETE FROM "liquidation_line" WHERE "liquidationId" IN (SELECT id FROM "liquidation" WHERE "shipmentId" = '${SHIPMENT_ID}')`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "liquidation" WHERE "shipmentId" = '${SHIPMENT_ID}'`);

    for (const table of CHILD_TABLES) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "shipmentId" = '${SHIPMENT_ID}'`);
    }

    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE id = '${SHIPMENT_ID}'`);
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
          (id, "shipmentId", "expenseCategoryId", amount, "spentAt", "payeeRequired", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('billable-no-payee')}', '${SHIPMENT_ID}', '${fuelCategoryId}', 100, now(), true, now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/billable_expense_payee_required/);
  });
});

describe('gross profit', () => {
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
        data: { shipmentId: SHIPMENT_ID, status: LiquidationStatus.PENDING },
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
      prisma.liquidation.create({ data: { shipmentId: SHIPMENT_ID } }),
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
