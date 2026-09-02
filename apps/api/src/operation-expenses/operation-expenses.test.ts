import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  createPrismaClient,
  testUuid,
  withActor,
  withTriggersSuspended,
  type ExtendedPrismaClient,
} from '@eztruckr/db';
import { ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { CompanyPaidExpensesService } from '../shipments/company-paid-expenses.service';
import { GrossProfitService } from '../shipments/gross-profit.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { OperationExpensesService } from './operation-expenses.service';

/**
 * What it costs to keep the company open.
 *
 * FOUR THINGS ARE WORTH A SUITE HERE, and none of them is the CRUD.
 *
 * The first is the claim the whole table exists to make: overhead is NOT a cost
 * of any trip. That is asserted against `GrossProfitService` directly rather
 * than by reading the schema, because the failure mode is somebody later
 * "improving" the P&L by joining this in, and a test that only reads a column
 * list would not notice.
 *
 * The second is the date window. This ledger is always read as a period, the
 * upper bound is EXCLUSIVE, and a boundary expense counted in two consecutive
 * months is the kind of error that reconciles to nothing and is found in
 * March.
 *
 * The third is that the summary and the list describe the same rows. Two filter
 * builders would eventually narrow differently, and a total that ignores the
 * category filter reads as plausible indefinitely.
 *
 * The fourth is the payee rule surviving a PATCH — the trap
 * `CompanyPaidExpensesService` documents, re-tested here because the guard is
 * shared and a shared guard with one untested caller is half a guard.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let expenses: OperationExpensesService;
let shipments: ShipmentsService;
let grossProfits: GrossProfitService;
/** The trip side of the same guard, so the suite proves it points both ways. */
let companyPaid: CompanyPaidExpensesService;

let adminId: string;

/** Reserved block: see the suite table in HANDOFF.md. */
const PREFIX = '0000000d-';
const id = (name: string) => testUuid('0000000d', name);

const ABSENT_ID = 'ffffffff-0000-7000-8000-00000000000d';

/** Requires a payee; the category rule this suite exercises both ways. */
const STRICT_CATEGORY = id('category-strict');
/** Does not. Toll booths and roadside meals are the real cases. */
const LOOSE_CATEGORY = id('category-loose');
/** Offered on both sides at once. */
const SHARED_CATEGORY = id('category-shared');
/** Trip-side only: the overhead ledger must refuse it. */
const TRIP_ONLY_CATEGORY = id('category-trip-only');
const PAYEE_ID = id('payee');
const SHIPMENT_ID = id('shipment');

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM "operation_expense" WHERE id::text LIKE '${PREFIX}%'`);
    // Anything the service created carries a generated id, so the fixtures it
    // points at have to be cleared by relationship rather than by prefix.
    await tx.$executeRawUnsafe(
      `DELETE FROM "operation_expense" WHERE "expenseCategoryId"::text LIKE '${PREFIX}%'`,
    );
    // And anything inside the reserved window, whatever category it used. The
    // two clauses above match by id and by fixture category, and a row created
    // by hand against a SEEDED category slips past both — which is exactly what
    // happened, and what broke the period assertions.
    await tx.$executeRawUnsafe(
      `DELETE FROM "operation_expense" WHERE "spentAt" >= '2029-01-01' AND "spentAt" < '2030-01-01'`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "company_paid_expense" WHERE "shipmentId" = '${SHIPMENT_ID}'`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE id = '${SHIPMENT_ID}'`);
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
    console.warn('[operation-expenses] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  const service = { client: prisma } as unknown as PrismaService;
  expenses = new OperationExpensesService(service);
  shipments = new ShipmentsService(service);
  grossProfits = new GrossProfitService(service, shipments);
  companyPaid = new CompanyPaidExpensesService(service, shipments);
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!available) return;

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    await prisma.expenseCategory.create({
      data: {
        id: STRICT_CATEGORY,
        name: `${PREFIX}Office rent`,
        requiresPayee: true,
        offeredOnTrips: false,
        offeredOnOverhead: true,
      },
    });
    await prisma.expenseCategory.create({
      data: {
        id: LOOSE_CATEGORY,
        name: `${PREFIX}Sundries`,
        requiresPayee: false,
        offeredOnTrips: false,
        offeredOnOverhead: true,
      },
    });
    // Offered on BOTH, which is the case a second category table could not
    // express: fuel, tolls and repairs happen on a trip and off it.
    await prisma.expenseCategory.create({
      data: {
        id: SHARED_CATEGORY,
        name: `${PREFIX}Fuel`,
        requiresPayee: false,
        offeredOnTrips: true,
        offeredOnOverhead: true,
      },
    });
    // A pure trip category — the one this ledger must refuse.
    await prisma.expenseCategory.create({
      data: {
        id: TRIP_ONLY_CATEGORY,
        name: `${PREFIX}Driver's meal`,
        requiresPayee: false,
        offeredOnTrips: true,
        offeredOnOverhead: false,
      },
    });
    await prisma.payee.create({
      data: { id: PAYEE_ID, payeeType: 1, name: `${PREFIX}Ayala Land` },
    });
  });
});

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

function record(
  amount: string,
  over: Partial<Parameters<typeof expenses.add>[0]> = {},
): ReturnType<typeof expenses.add> {
  return act(() =>
    expenses.add({
      expenseCategoryId: LOOSE_CATEGORY,
      description: null,
      amount,
      spentAt: '2029-08-15T02:00:00.000Z',
      payeeId: null,
      referenceNumber: null,
      receiptId: null,
      ...over,
    }),
  );
}

/**
 * A YEAR THIS SUITE RESERVES, the way it reserves a uuid block.
 *
 * The summary is a GLOBAL aggregate — that is its job — so an assertion about
 * "what August cost" is an assertion about every row in a shared database, and
 * a single expense left behind by anything else makes it wrong. It already did
 * once: a row recorded by hand while verifying against a running server broke
 * the boundary test two days later, from a category this suite does not own and
 * with an id outside its block, so neither cleanup clause could see it.
 *
 * Reserving a window on the axis this table is actually queried by is the same
 * trick as `testUuid`'s block, applied to the other dimension. Nothing real is
 * dated 2029.
 */
const AUGUST = { from: '2029-08-01T00:00:00.000Z', to: '2029-09-01T00:00:00.000Z' };
const SEPTEMBER = { from: '2029-09-01T00:00:00.000Z', to: '2029-10-01T00:00:00.000Z' };

const listing = (over: Record<string, unknown> = {}) =>
  act(() => expenses.list({ page: 1, pageSize: 100, ...over } as never));

const summary = (over: Record<string, unknown> = {}) =>
  act(() => expenses.summarise({ ...over } as never));

/**
 * The FIELD errors, not the wrapper.
 *
 * A refused write arrives as `{ message: 'Validation failed', errors: [...] }`,
 * so a plain `rejects.toThrow(/…/)` matches the wrapper and passes no matter
 * which field was actually wrong. `trip-profit.test.ts` and
 * `liquidation-lifecycle.test.ts` carry the same helper for the same reason.
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

describe('recording overhead', () => {
  it('records it against no trip at all, with the day the money left', async () => {
    if (!available) return;

    const expense = await record('42000.00', {
      expenseCategoryId: STRICT_CATEGORY,
      payeeId: PAYEE_ID,
      description: 'August lease',
      referenceNumber: 'INV-2026-081',
      spentAt: '2029-08-05T01:00:00.000Z',
    });

    expect(expense.amount).toBe('42000');
    expect(expense.spentAt).toBe('2029-08-05T01:00:00.000Z');
    expect(expense.expenseCategoryName).toBe(`${PREFIX}Office rent`);
    expect(expense.payeeName).toBe(`${PREFIX}Ayala Land`);
    expect(expense.referenceNumber).toBe('INV-2026-081');
    // No shipment field exists to be null: the record is not trip-shaped.
    expect(expense).not.toHaveProperty('shipmentId');
  });

  it('freezes the category rule onto the row rather than reading it live', async () => {
    if (!available) return;

    const expense = await record('1200.00', {
      expenseCategoryId: STRICT_CATEGORY,
      payeeId: PAYEE_ID,
    });
    expect(expense.payeeRequired).toBe(true);

    // Relaxing the category must not retroactively change what this row said
    // the rule was when it was written.
    await act(() =>
      prisma.expenseCategory.update({
        where: { id: STRICT_CATEGORY },
        data: { requiresPayee: false },
      }),
    );

    const reloaded = await act(() => expenses.get(expense.id));
    expect(reloaded.payeeRequired).toBe(true);
  });

  it('refuses a category that demands a payee when none is named, and says which', async () => {
    if (!available) return;

    // The refusal is against `payeeId` and NAMES THE CATEGORY, because that is
    // what the person filling the form chose and can act on. "Payee is
    // required" alone reads as a bug when the previous line needed none.
    const errors = await validationErrors(() =>
      record('1200.00', { expenseCategoryId: STRICT_CATEGORY }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('payeeId');
    expect(errors[0]?.message).toMatch(/Office rent/);
  });

  it('refuses a payee that does not exist', async () => {
    if (!available) return;

    await expect(record('500.00', { payeeId: ABSENT_ID })).rejects.toThrow(BadRequestException);
  });

  it('refuses a negative amount in the database, not merely in Zod', async () => {
    if (!available) return;

    // Raw SQL, so the schema's own CHECK is what is under test rather than the
    // request pipeline that normally never lets one through.
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "operation_expense"
          (id, "expenseCategoryId", amount, "spentAt", "payeeRequired",
           "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('negative')}', '${LOOSE_CATEGORY}', -1, now(), false,
                now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/operation_expense_amount_positive/i);
  });

  it('refuses a row whose frozen rule and payee disagree, in the database', async () => {
    if (!available) return;

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "operation_expense"
          (id, "expenseCategoryId", amount, "spentAt", "payeeRequired", "payeeId",
           "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('unpaired')}', '${STRICT_CATEGORY}', 100, now(), true, NULL,
                now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/operation_expense_payee_required/i);
  });
});

describe('correcting one', () => {
  /**
   * The trap `CompanyPaidExpensesService` documents: a PATCH that mentions only
   * the category can make a legal row illegal, and validating the request alone
   * would miss it because the request names no payee to complain about.
   */
  it('re-applies the payee rule against the row as the patch will leave it', async () => {
    if (!available) return;

    const expense = await record('300.00');
    expect(expense.payeeRequired).toBe(false);

    const errors = await validationErrors(() =>
      act(() => expenses.update(expense.id, { expenseCategoryId: STRICT_CATEGORY })),
    );

    expect(errors[0]?.path).toBe('payeeId');
    expect(errors[0]?.message).toMatch(/Office rent/);
  });

  it('accepts the same move when the patch supplies the payee too', async () => {
    if (!available) return;

    const expense = await record('300.00');

    const updated = await act(() =>
      expenses.update(expense.id, { expenseCategoryId: STRICT_CATEGORY, payeeId: PAYEE_ID }),
    );

    expect(updated.payeeRequired).toBe(true);
    expect(updated.payeeName).toBe(`${PREFIX}Ayala Land`);
  });

  it('refuses clearing a payee the row now requires', async () => {
    if (!available) return;

    const expense = await record('300.00', {
      expenseCategoryId: STRICT_CATEGORY,
      payeeId: PAYEE_ID,
    });

    const errors = await validationErrors(() =>
      act(() => expenses.update(expense.id, { payeeId: null })),
    );

    expect(errors[0]?.path).toBe('payeeId');
    expect(errors[0]?.message).toMatch(/Office rent/);
  });

  it('has no lock: last quarter stays correctable', async () => {
    if (!available) return;

    const expense = await record('300.00', { spentAt: '2029-01-04T02:00:00.000Z' });
    const updated = await act(() => expenses.update(expense.id, { amount: '350.00' }));

    expect(updated.amount).toBe('350');
  });

  it('404s on an id belonging to nothing', async () => {
    if (!available) return;

    await expect(act(() => expenses.update(ABSENT_ID, { amount: '1.00' }))).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('reading a period', () => {
  /**
   * The upper bound is EXCLUSIVE, so consecutive months tile exactly. A closed
   * bound would count the boundary row in both, and the two months would each
   * look right on their own.
   */
  it('counts a boundary expense in exactly one of two consecutive months', async () => {
    if (!available) return;

    await record('1000.00', { spentAt: '2029-09-01T00:00:00.000Z' });

    const august = await summary(AUGUST);
    const september = await summary(SEPTEMBER);

    expect(august.total).toBe('0.00');
    expect(september.total).toBe('1000.00');
  });

  it('includes the lower bound, which is inclusive', async () => {
    if (!available) return;

    await record('700.00', { spentAt: '2029-08-01T00:00:00.000Z' });

    expect((await summary(AUGUST)).total).toBe('700.00');
  });

  it('totals the period and breaks it down by category, largest first', async () => {
    if (!available) return;

    await record('42000.00', { expenseCategoryId: STRICT_CATEGORY, payeeId: PAYEE_ID });
    await record('1500.00');
    await record('500.00');

    const august = await summary(AUGUST);

    expect(august.total).toBe('44000.00');
    expect(august.count).toBe(3);
    expect(august.from).toBe(AUGUST.from);
    expect(
      august.byCategory.map((row) => [row.expenseCategoryName, row.amount, row.count]),
    ).toEqual([
      [`${PREFIX}Office rent`, '42000.00', 1],
      [`${PREFIX}Sundries`, '2000.00', 2],
    ]);
  });

  /**
   * The total above a table has to describe the rows in it. One filter builder
   * serves both; this is what would fail if a second appeared.
   */
  it('summarises exactly the rows the list returns, under the same filter', async () => {
    if (!available) return;

    await record('42000.00', { expenseCategoryId: STRICT_CATEGORY, payeeId: PAYEE_ID });
    await record('1500.00');

    const filter = { ...AUGUST, expenseCategoryId: LOOSE_CATEGORY };
    const [page, totals] = await Promise.all([listing(filter), summary(filter)]);

    expect(page.total).toBe(1);
    expect(totals.count).toBe(1);
    expect(totals.total).toBe('1500.00');
  });

  it('reports an empty period as zero rather than as nothing', async () => {
    if (!available) return;

    const quiet = await summary({
      from: '2020-01-01T00:00:00.000Z',
      to: '2020-02-01T00:00:00.000Z',
    });

    expect(quiet.total).toBe('0.00');
    expect(quiet.count).toBe(0);
    expect(quiet.byCategory).toEqual([]);
  });

  it('drops a removed expense out of the total', async () => {
    if (!available) return;

    const expense = await record('900.00');
    expect((await summary(AUGUST)).total).toBe('900.00');

    await act(() => expenses.remove(expense.id));

    expect((await summary(AUGUST)).total).toBe('0.00');
    // A soft delete, so the row is still there to say who reversed it.
    const [row] = await prisma.$queryRawUnsafe<{ deletedBy: string | null }[]>(
      `SELECT "deletedBy" FROM "operation_expense" WHERE id = '${expense.id}'`,
    );
    expect(row?.deletedBy).toBe(adminId);
  });

  it('searches the description, the reference and the payee', async () => {
    if (!available) return;

    await record('100.00', { description: 'Meralco August' });
    await record('200.00', { referenceNumber: 'PLDT-99' });
    await record('300.00', { payeeId: PAYEE_ID });

    expect((await listing({ search: 'meralco' })).total).toBe(1);
    expect((await listing({ search: 'PLDT' })).total).toBe(1);
    expect((await listing({ search: 'ayala' })).total).toBe(1);
  });
});

describe('a trip does not pay for the office', () => {
  /**
   * THE CLAIM THE TABLE EXISTS TO MAKE, asserted against the P&L service rather
   * than against a column list. Overhead is not attributable to any one trip,
   * and the failure this guards is somebody later joining it into gross profit
   * to make the margin "more accurate".
   */
  it('leaves every figure in a shipment gross profit untouched', async () => {
    if (!available) return;

    await act(async () => {
      await prisma.client.create({ data: { id: id('client'), name: `${PREFIX}Client` } });
      await prisma.shipment.create({
        data: {
          id: SHIPMENT_ID,
          shipmentNumber: `${PREFIX}SHP-OPEX`.toUpperCase(),
          status: ShipmentStatus.IN_TRANSIT,
          clientId: id('client'),
          origin: 'Manila',
          destination: 'Batangas',
          grossRate: '50000.0000',
          tpcAmount: '5000.0000',
          netRate: '45000.0000',
        },
      });
    });

    const before = await act(() => grossProfits.forShipment(SHIPMENT_ID));

    await record('42000.00', { expenseCategoryId: STRICT_CATEGORY, payeeId: PAYEE_ID });

    const after = await act(() => grossProfits.forShipment(SHIPMENT_ID));

    expect(after).toEqual(before);
    expect(after.cost).toBe('0.00');
  });
});

/**
 * Where a category is offered.
 *
 * WHAT THIS PREVENTS is concrete and was real for one commit: the overhead
 * ledger and the three trip-side forms all fetched `expense_category`
 * unfiltered, so the first "Office rent" anybody created to run this screen
 * appeared in a CREW MEMBER'S LIQUIDATION DROPDOWN, on the road, beside Fuel
 * and Toll.
 *
 * THE FIX WAS A COLUMN, NOT A SECOND TABLE, and the test that says so is the
 * shared-category one below: fuel is fuel whether it went into a truck on a job
 * or the office pickup, and two tables would make that two rows nobody keeps in
 * step.
 *
 * FILTERING THE PICKER IS NOT THE CONTROL. The picker is a courtesy; these
 * assertions go through the service, because a stale query cache or a hand-made
 * request would otherwise walk straight past it.
 */
describe('a category has to be offered here before it can be filed here', () => {
  it('refuses a trip-only category, and says where it does belong', async () => {
    if (!available) return;

    const errors = await validationErrors(() =>
      record('500.00', { expenseCategoryId: TRIP_ONLY_CATEGORY }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('expenseCategoryId');
    expect(errors[0]?.message).toMatch(/Driver's meal is a trip category/);
    // Names the way out, because the person is looking at a list that should
    // not have offered it.
    expect(errors[0]?.message).toMatch(/Expense categories/);
  });

  it('refuses it on a PATCH too, not only on the create', async () => {
    if (!available) return;

    const expense = await record('500.00');

    const errors = await validationErrors(() =>
      act(() => expenses.update(expense.id, { expenseCategoryId: TRIP_ONLY_CATEGORY })),
    );

    expect(errors[0]?.path).toBe('expenseCategoryId');
  });

  /**
   * THE CASE THAT RULES OUT A SECOND TABLE. One category, offered on both
   * sides, filed against both ledgers — so "what did we spend on fuel this
   * year" is one `expenseCategoryId`, not a union over two lists.
   */
  it('accepts one offered on both sides, which is the whole argument', async () => {
    if (!available) return;

    const expense = await record('3000.00', { expenseCategoryId: SHARED_CATEGORY });

    expect(expense.expenseCategoryName).toBe(`${PREFIX}Fuel`);
  });

  /**
   * The mirror, from the trip side. Without it this suite would only prove the
   * guard points one way, and the trip-side callers are three of the four.
   */
  it('refuses an overhead-only category on a trip cost', async () => {
    if (!available) return;

    await act(async () => {
      await prisma.client.create({ data: { id: id('client'), name: `${PREFIX}Client` } });
      await prisma.shipment.create({
        data: {
          id: SHIPMENT_ID,
          shipmentNumber: `${PREFIX}SHP-OPEX`.toUpperCase(),
          status: ShipmentStatus.IN_TRANSIT,
          clientId: id('client'),
          origin: 'Manila',
          destination: 'Batangas',
          grossRate: '50000.0000',
          tpcAmount: '5000.0000',
          netRate: '45000.0000',
        },
      });
    });

    const errors = await validationErrors(() =>
      act(() =>
        companyPaid.add(SHIPMENT_ID, {
          expenseCategoryId: LOOSE_CATEGORY,
          description: null,
          amount: '100.00',
          spentAt: '2029-08-15T02:00:00.000Z',
          payeeId: null,
          referenceNumber: null,
          receiptId: null,
        }),
      ),
    );

    expect(errors[0]?.path).toBe('expenseCategoryId');
    expect(errors[0]?.message).toMatch(/Sundries is an overhead category/);
  });

  /**
   * A category offered nowhere cannot be filed against from any screen, so it
   * is a row that silently does nothing. Refused by the DATABASE rather than by
   * Zod, because both flags can be cleared by two separate PATCHes that are
   * each individually legal — the request schema only ever sees one of them.
   */
  it('refuses a category offered nowhere, in the database', async () => {
    if (!available) return;

    await expect(
      prisma.$executeRawUnsafe(`
        UPDATE "expense_category"
           SET "offeredOnTrips" = false, "offeredOnOverhead" = false
         WHERE id = '${SHARED_CATEGORY}'
      `),
    ).rejects.toThrow(/expense_category_offered_somewhere/i);
  });
});
