import { NotFoundException } from '@nestjs/common';
import {
  createPrismaClient,
  withActor,
  type ExtendedPrismaClient,
  testUuid,
  withTriggersSuspended,
} from '@eztruckr/db';
import {
  PaymentMethod,
  PaymentVerificationStatus,
  ShipmentStatus,
  UserRole,
} from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestUser } from '../auth/request-user';
import type { PrismaService } from '../prisma/prisma.service';
import { ClientPaymentsService } from './client-payments.service';
import { GrossProfitService } from './gross-profit.service';
import { ShipmentChargesService } from './shipment-charges.service';
import { ShipmentsService } from './shipments.service';

/**
 * What the client has paid, and what is still outstanding.
 *
 * TWO THINGS ARE WORTH A SUITE HERE, and neither is the CRUD. The first is that
 * what a trip is OWED is the same figure gross profit calls revenue — an
 * invoice chased on one number and a margin reported on another is a
 * disagreement nobody notices until a client does, so it is asserted directly
 * against `GrossProfitService` rather than against a copy of the arithmetic.
 *
 * The second is the status ladder at its ends: nothing received, and more
 * received than was asked for. Both are states a naive comparison reports
 * wrongly, and both are what somebody reads off a screen before ringing a
 * client.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let shipments: ShipmentsService;
let charges: ShipmentChargesService;
let payments: ClientPaymentsService;
let grossProfits: GrossProfitService;

let adminId: string;
let clientId: string;

/** Not `itest-`: see the note in liquidation-lifecycle.test.ts. */
const PREFIX = '0000000a-';
const id = (name: string) => testUuid('0000000a', name);

/** Well-formed, and belonging to no row — ids are `uuid` columns, so a
 * placeholder like 'no-such-payment' fails the cast before any row is compared. */
const ABSENT_ID = 'ffffffff-0000-7000-8000-00000000000a';

const SHIPMENT_ID = id('shipment');
/** A second trip, for the checks that need one payment to belong elsewhere. */
const OTHER_SHIPMENT_ID = id('other-shipment');

const CHILD_TABLES = ['client_payment', 'billable_expense', 'additional_charge'];

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    for (const shipmentId of [SHIPMENT_ID, OTHER_SHIPMENT_ID]) {
      for (const table of CHILD_TABLES) {
        await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "shipmentId" = '${shipmentId}'`);
      }
      await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE id = '${shipmentId}'`);
    }

    await tx.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[client-payments] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  const service = { client: prisma } as unknown as PrismaService;
  shipments = new ShipmentsService(service);
  charges = new ShipmentChargesService(service, shipments);
  payments = new ClientPaymentsService(service, shipments);
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
    await prisma.client.create({ data: { id: id('client'), name: 'Payment Test Client' } });
    clientId = id('client');

    for (const [suffix, shipmentId] of [
      ['A', SHIPMENT_ID],
      ['B', OTHER_SHIPMENT_ID],
    ] as const) {
      await prisma.shipment.create({
        data: {
          id: shipmentId,
          shipmentNumber: `${PREFIX}SHP-${suffix}`.toUpperCase(),
          status: ShipmentStatus.IN_TRANSIT,
          clientId,
          origin: 'Manila',
          destination: 'Batangas',
          // 50,000 gross with a 5,000 broker cut leaves 45,000 net — the
          // figure the client is billed before any rebilled expense.
          grossRate: '50000.0000',
          tpcAmount: '5000.0000',
          netRate: '45000.0000',
        },
      });
    }
  });
});

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

/**
 * The two sessions this suite is about.
 *
 * A dispatch manager's entry needs checking and an accountant's does not, so
 * almost every assertion below turns on which of these did the writing. Both
 * carry the same `id` because the audit columns are not what is under test —
 * the ROLE is.
 */
const asAccounting = (): RequestUser => ({
  id: adminId,
  email: 'admin@eztruckr.ph',
  name: 'Accounting',
  role: UserRole.ACCOUNTING,
  isActive: true,
  staffId: null,
});

const asDispatchManager = (): RequestUser => ({
  id: adminId,
  email: 'dispatch@eztruckr.ph',
  name: 'Dispatch manager',
  role: UserRole.DISPATCH_MANAGER,
  isActive: true,
  staffId: null,
});

function pay(
  amount: string,
  over: Partial<Parameters<typeof payments.record>[1]> = {},
  user: RequestUser = asAccounting(),
) {
  return act(() =>
    payments.record(
      SHIPMENT_ID,
      {
        amount,
        receivedAt: null,
        paymentMethod: PaymentMethod.BANK_TRANSFER,
        referenceNumber: null,
        receiptId: null,
        remarks: null,
        ...over,
      },
      user,
    ),
  );
}

/** The same, recorded by the desk whose work needs checking. */
const collect = (amount: string, over: Partial<Parameters<typeof payments.record>[1]> = {}) =>
  pay(amount, over, asDispatchManager());

async function setStatus(status: ShipmentStatus): Promise<void> {
  await prisma.shipment.update({ where: { id: SHIPMENT_ID }, data: { status } });
}

describe('recording a payment', () => {
  it('records it against the trip, with the day the money arrived', async () => {
    if (!available) return;

    const payment = await pay('20000.00', {
      receivedAt: '2026-08-11T00:00:00.000Z',
      paymentMethod: PaymentMethod.CHECK,
      referenceNumber: 'BPI-004417',
      remarks: 'Downpayment',
    });

    expect(payment.amount).toBe('20000.00');
    expect(payment.receivedAt).toBe('2026-08-11T00:00:00.000Z');
    expect(payment.paymentMethod).toBe(PaymentMethod.CHECK);
    expect(payment.referenceNumber).toBe('BPI-004417');
  });

  /**
   * THE ONE THING THIS RECORD EXISTS TO PROTECT. A trip is rarely settled in
   * one movement, and an `amountPaid` field would be overwritten by the balance
   * — losing the downpayment's date, method and check number with it.
   */
  it('adds a row per payment rather than overwriting a running total', async () => {
    if (!available) return;

    await pay('20000.00', { receivedAt: '2026-08-11T00:00:00.000Z' });
    await pay('25000.00', { receivedAt: '2026-09-10T00:00:00.000Z' });

    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.paymentCount).toBe(2);
    expect(summary.amountPaid).toBe('45000.00');
    // Oldest first: the order the money arrived in.
    expect(summary.payments.map((row) => row.amount)).toEqual(['20000.00', '25000.00']);
  });

  it('refuses a receipt id that belongs to no upload', async () => {
    if (!available) return;

    await expect(pay('1000.00', { receiptId: ABSENT_ID })).rejects.toThrow(/Validation failed/);
  });

  /**
   * The database refuses it too, not only the schema. Written as raw SQL
   * because the Zod refinement never runs on this path — which is the point:
   * a negative payment cannot be reached by ANY route.
   */
  it('refuses a non-positive amount in the database as well as the schema', async () => {
    if (!available) return;

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "client_payment"
          (id, "shipmentId", amount, "paymentMethod", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('negative')}', '${SHIPMENT_ID}', -100, ${PaymentMethod.CASH},
                now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/client_payment_amount_positive/i);
  });
});

describe('what the trip is owed', () => {
  /**
   * THE ASSERTION THAT MATTERS: what the client owes and what the P&L calls
   * revenue are the same figure, computed once. Compared against the other
   * service rather than against a literal, so a change to either definition
   * fails here instead of quietly producing two truths.
   */
  it('is the same figure gross profit calls revenue', async () => {
    if (!available) return;

    await act(() =>
      charges.addAdditionalCharge(SHIPMENT_ID, {
        description: 'Extra drop',
        amount: '2500.00',
        isCommissionable: false,
      }),
    );

    await act(() =>
      charges.addBillableExpense(SHIPMENT_ID, {
        expenseCategoryId: null,
        description: 'Port charges',
        amount: '1500.00',
        spentAt: '2026-08-11T00:00:00.000Z',
        isCommissionable: false,
        payeeId: null,
        liquidationLineId: null,
        referenceNumber: null,
        receiptId: null,
      }),
    );

    const [summary, profit] = await Promise.all([
      payments.summary(SHIPMENT_ID),
      grossProfits.forShipment(SHIPMENT_ID),
    ]);

    expect(summary.amountDue).toBe(profit.revenue);
    // And it decomposes, so a client disputing the figure can be shown it.
    expect(summary.netRate).toBe('45000.00');
    expect(summary.billableExpenses).toBe('1500.00');
    expect(summary.additionalCharges).toBe('2500.00');
    expect(summary.amountDue).toBe('49000.00');
  });

  /**
   * A late charge moves what is owed, so a balance read while the trip is open
   * can still grow. Chasing one that is still moving is how a client gets
   * invoiced twice, and the screen says so rather than leaving accounting to
   * infer it from the status.
   */
  it('says so while a charge can still be added, and stops once it cannot', async () => {
    if (!available) return;

    expect((await payments.summary(SHIPMENT_ID)).amountDueIsProvisional).toBe(true);

    // Still provisional at LIQUIDATED, because a charge may still be added
    // there. Asserted rather than skipped past: this is the step where the
    // caveat used to disappear while the figure could still move.
    await setStatus(ShipmentStatus.LIQUIDATED);

    expect((await payments.summary(SHIPMENT_ID)).amountDueIsProvisional).toBe(true);

    await setStatus(ShipmentStatus.CLOSED);

    expect((await payments.summary(SHIPMENT_ID)).amountDueIsProvisional).toBe(false);

    // Handed back at the status the rest of the file inherited before CLOSED
    // came into this test, so nothing downstream reads a trip closed early.
    await setStatus(ShipmentStatus.LIQUIDATED);
  });
});

describe('where the trip stands', () => {
  it('is UNPAID with a balance of the whole invoice', async () => {
    if (!available) return;

    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.status).toBe('UNPAID');
    expect(summary.amountPaid).toBe('0.00');
    expect(summary.balance).toBe('45000.00');
  });

  it('is PARTIALLY_PAID after a downpayment', async () => {
    if (!available) return;

    await pay('20000.00');
    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.status).toBe('PARTIALLY_PAID');
    expect(summary.balance).toBe('25000.00');
  });

  it('is PAID once the balance is settled', async () => {
    if (!available) return;

    await pay('20000.00');
    await pay('25000.00');
    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.status).toBe('PAID');
    expect(summary.balance).toBe('0.00');
  });

  /**
   * REPORTED, NEVER REFUSED, and the balance is not clamped: "we owe them
   * ₱5,000" is a fact somebody has to act on, and a zero would hide it.
   */
  it('is OVERPAID with a negative balance, rather than refusing the payment', async () => {
    if (!available) return;

    await pay('50000.00');
    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.status).toBe('OVERPAID');
    expect(summary.balance).toBe('-5000.00');
  });
});

/**
 * THE DELIBERATE DIFFERENCE FROM AN ALLOWANCE, and the one somebody will try to
 * "make consistent". A release is refused on a closed trip because a closed
 * trip can no longer account for cash it hands out. A client's payment is the
 * other direction: thirty- and sixty-day terms mean the check routinely
 * arrives after the crew were paid and the trip was closed, and refusing it
 * would make the LAST payment on every trip the one that cannot be recorded.
 */
describe('a trip that has already closed', () => {
  it('still accepts the payment that finally arrives', async () => {
    if (!available) return;

    await setStatus(ShipmentStatus.CLOSED);

    const payment = await pay('45000.00');

    expect(payment.amount).toBe('45000.00');
    expect((await payments.summary(SHIPMENT_ID)).status).toBe('PAID');
  });
});

describe('reversing a payment', () => {
  /**
   * A bounced check and a refund are both this: the removal of a receipt that
   * turns out not to have happened. The soft delete records who reversed it and
   * when, which is more than a negative row would carry and cannot be mistaken
   * for money received.
   */
  it('takes it back off the balance', async () => {
    if (!available) return;

    const payment = await pay('45000.00');
    expect((await payments.summary(SHIPMENT_ID)).status).toBe('PAID');

    await act(() => payments.remove(SHIPMENT_ID, payment.id, asAccounting()));

    const summary = await payments.summary(SHIPMENT_ID);
    expect(summary.status).toBe('UNPAID');
    expect(summary.balance).toBe('45000.00');
    expect(summary.paymentCount).toBe(0);
  });

  /**
   * The id is checked against the shipment in the PATH, not just the table.
   * Without it, one trip's URL would reach another trip's money.
   */
  it('refuses to reach a payment recorded on another trip', async () => {
    if (!available) return;

    const elsewhere = await act(() =>
      payments.record(
        OTHER_SHIPMENT_ID,
        {
          amount: '1000.00',
          receivedAt: null,
          paymentMethod: PaymentMethod.CASH,
          referenceNumber: null,
          receiptId: null,
          remarks: null,
        },
        asAccounting(),
      ),
    );

    await expect(
      act(() => payments.remove(SHIPMENT_ID, elsewhere.id, asAccounting())),
    ).rejects.toThrow(NotFoundException);
  });
});

/**
 * One check legitimately settles two trips and carries one number on both, so
 * a unique index would refuse a true record. The far commoner cause of a repeat
 * is the same slip entered twice — usually on two different shipments, which is
 * precisely when nobody notices.
 */
describe('a reference number seen twice', () => {
  it('is recorded, and reported on the row', async () => {
    if (!available) return;

    await pay('20000.00', { referenceNumber: 'BPI-004417' });
    await act(() =>
      payments.record(
        OTHER_SHIPMENT_ID,
        {
          amount: '25000.00',
          receivedAt: null,
          paymentMethod: PaymentMethod.CHECK,
          // Same slip, different case: two people typing one check number.
          referenceNumber: 'bpi-004417',
          receiptId: null,
          remarks: null,
        },
        asAccounting(),
      ),
    );

    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.paymentCount).toBe(1);
    expect(summary.payments[0]?.referenceNumberIsDuplicated).toBe(true);
  });

  it('leaves a reference used once alone', async () => {
    if (!available) return;

    await pay('20000.00', { referenceNumber: 'BPI-004418' });

    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.payments[0]?.referenceNumberIsDuplicated).toBe(false);
  });
});

/**
 * THE CONTROL THE VERIFICATION STATE EXISTS FOR: the person who books a receipt
 * and the person who confirms it against the bank are two people.
 */
describe('a payment recorded by dispatch', () => {
  it('arrives unverified, and names nobody as having checked it', async () => {
    if (!available) return;

    const payment = await collect('20000.00');

    expect(payment.verificationStatus).toBe(PaymentVerificationStatus.UNVERIFIED);
    expect(payment.verifiedBy).toBeNull();
    expect(payment.verifiedAt).toBeNull();
    expect((await payments.summary(SHIPMENT_ID)).awaitingVerification).toBe(1);
  });

  /**
   * COUNTED WHILE IT WAITS. Money a client demonstrably sent does not become
   * less sent while accounting works through a queue, and a receivables figure
   * that lagged would have somebody chasing a client who had already paid.
   */
  it('still counts toward what the trip has collected', async () => {
    if (!available) return;

    await collect('20000.00');
    const summary = await payments.summary(SHIPMENT_ID);

    expect(summary.amountPaid).toBe('20000.00');
    expect(summary.balance).toBe('25000.00');
    expect(summary.status).toBe('PARTIALLY_PAID');
    // But nobody has confirmed any of it, and the summary says so.
    expect(summary.amountVerified).toBe('0.00');
  });

  it('is confirmed by accounting, which names who and when', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    const verified = await act(() => payments.verify(recorded.id, asAccounting()));

    expect(verified.verificationStatus).toBe(PaymentVerificationStatus.VERIFIED);
    expect(verified.verifiedBy).toBe(adminId);
    expect(verified.verifiedAt).not.toBeNull();
    expect(verified.verificationNote).toBeNull();

    const summary = await payments.summary(SHIPMENT_ID);
    expect(summary.amountVerified).toBe('20000.00');
    expect(summary.awaitingVerification).toBe(0);
  });
});

/**
 * An accountant booking a payment off the statement in front of them has
 * already been both people. Padding the queue with rows nobody can learn
 * anything from is how a queue starts being bulk-cleared without reading.
 */
describe('a payment recorded by accounting', () => {
  it('is verified on the spot and never joins the queue', async () => {
    if (!available) return;

    const payment = await pay('20000.00');

    expect(payment.verificationStatus).toBe(PaymentVerificationStatus.VERIFIED);
    expect(payment.verifiedBy).toBe(adminId);
    expect((await payments.summary(SHIPMENT_ID)).awaitingVerification).toBe(0);
  });
});

describe('a payment accounting cannot match', () => {
  it('goes back for correction with the reason, and stops counting as collected', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    const returned = await act(() =>
      payments.returnForCorrection(
        recorded.id,
        { reason: 'No such deposit on the 11th — check the date.' },
        asAccounting(),
      ),
    );

    expect(returned.verificationStatus).toBe(PaymentVerificationStatus.RETURNED);
    expect(returned.verificationNote).toBe('No such deposit on the 11th — check the date.');

    // Excluded from the total, and reported separately so it cannot just
    // vanish: somebody looked and said they could not find it, which is not
    // the same as nobody having looked.
    const summary = await payments.summary(SHIPMENT_ID);
    expect(summary.amountPaid).toBe('0.00');
    expect(summary.amountReturned).toBe('20000.00');
    expect(summary.status).toBe('UNPAID');
    expect(summary.paymentCount).toBe(1);
  });

  /**
   * The dispatch manager answering the return puts it back in front of
   * accounting rather than leaving them to remember it.
   */
  it('returns to the queue, and to the total, once corrected', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    await act(() =>
      payments.returnForCorrection(recorded.id, { reason: 'Wrong date.' }, asAccounting()),
    );

    const corrected = await act(() =>
      payments.update(
        SHIPMENT_ID,
        recorded.id,
        { receivedAt: '2026-08-12T00:00:00.000Z' },
        asDispatchManager(),
      ),
    );

    expect(corrected.verificationStatus).toBe(PaymentVerificationStatus.UNVERIFIED);
    expect(corrected.verificationNote).toBeNull();

    const summary = await payments.summary(SHIPMENT_ID);
    expect(summary.amountPaid).toBe('20000.00');
    expect(summary.awaitingVerification).toBe(1);
  });

  /**
   * THE SHAPE THE FORM ACTUALLY SENDS. The correction screen submits every
   * field on every save, not the one that changed — a different path through
   * the `undefined` / `null` conditionals in `update` than a hand-written
   * partial patch takes, and the one a person will actually exercise. Clearing
   * a reference to null is the case worth pinning: it must land as null rather
   * than being read as "not mentioned".
   */
  it('accepts the full field set the correction form submits', async () => {
    if (!available) return;

    const recorded = await collect('20000.00', {
      referenceNumber: 'BPI-004417',
      remarks: 'Downpayment',
    });
    await act(() =>
      payments.returnForCorrection(recorded.id, { reason: 'Wrong amount.' }, asAccounting()),
    );

    const corrected = await act(() =>
      payments.update(
        SHIPMENT_ID,
        recorded.id,
        {
          amount: '22500.00',
          receivedAt: '2026-08-12T00:00:00.000Z',
          paymentMethod: PaymentMethod.CHECK,
          referenceNumber: null,
          receiptId: null,
          remarks: null,
        },
        asDispatchManager(),
      ),
    );

    expect(corrected.amount).toBe('22500.00');
    expect(corrected.receivedAt).toBe('2026-08-12T00:00:00.000Z');
    expect(corrected.paymentMethod).toBe(PaymentMethod.CHECK);
    expect(corrected.referenceNumber).toBeNull();
    expect(corrected.remarks).toBeNull();
    // And it is back in front of accounting, with the answered note gone.
    expect(corrected.verificationStatus).toBe(PaymentVerificationStatus.UNVERIFIED);
    expect(corrected.verificationNote).toBeNull();

    const summary = await payments.summary(SHIPMENT_ID);
    expect(summary.amountPaid).toBe('22500.00');
    expect(summary.amountReturned).toBe('0.00');
  });

  /**
   * The database refuses a return with no reason, not only the schema. A refusal
   * with nothing to act on is whoever recorded it being told to look again with
   * no idea what to look for.
   */
  it('cannot be returned with no reason, even by raw SQL', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');

    await expect(
      prisma.$executeRawUnsafe(`
        UPDATE "client_payment"
           SET "verificationStatus" = ${PaymentVerificationStatus.RETURNED},
               "verifiedBy" = '${adminId}', "verifiedAt" = now(), "verificationNote" = NULL
         WHERE id = '${recorded.id}'
      `),
    ).rejects.toThrow(/client_payment_verification_matches_status/i);
  });
});

/**
 * THE LOCK. Without it the control is theatre: record something unremarkable,
 * wait for the tick, then change the amount.
 */
describe('once accounting has verified a payment', () => {
  it('the desk that recorded it can no longer change it', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    await act(() => payments.verify(recorded.id, asAccounting()));

    await expect(
      act(() =>
        payments.update(SHIPMENT_ID, recorded.id, { amount: '90000.00' }, asDispatchManager()),
      ),
    ).rejects.toThrow(/verified by accounting/i);
  });

  it('the desk that recorded it can no longer reverse it', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    await act(() => payments.verify(recorded.id, asAccounting()));

    await expect(
      act(() => payments.remove(SHIPMENT_ID, recorded.id, asDispatchManager())),
    ).rejects.toThrow(/verified by accounting/i);
  });

  /**
   * THE FIRST STAMP IS THE RECORD. There is no history table, so a second
   * verification would not say two people looked — it would erase the fact that
   * the first one did. The button is gone from the screen and the API refuses
   * it, so neither path can quietly overwrite an audit trail.
   */
  it('refuses a second verification rather than overwriting the first', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    const first = await act(() => payments.verify(recorded.id, asAccounting()));

    await expect(act(() => payments.verify(recorded.id, asAccounting()))).rejects.toThrow(
      /already verified/i,
    );

    const summary = await payments.summary(SHIPMENT_ID);
    expect(summary.payments[0]?.verifiedAt).toBe(first.verifiedAt);
  });

  /** Returning it is how a check somebody now doubts is undone — recorded. */
  it('can still be returned for correction, which is recorded', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    await act(() => payments.verify(recorded.id, asAccounting()));

    const returned = await act(() =>
      payments.returnForCorrection(
        recorded.id,
        { reason: 'Duplicate of the 9th.' },
        asAccounting(),
      ),
    );

    expect(returned.verificationStatus).toBe(PaymentVerificationStatus.RETURNED);
    expect(returned.verificationNote).toBe('Duplicate of the 9th.');
  });

  it('accounting still can, and their edit re-stamps the check', async () => {
    if (!available) return;

    const recorded = await collect('20000.00');
    await act(() => payments.verify(recorded.id, asAccounting()));

    const corrected = await act(() =>
      payments.update(SHIPMENT_ID, recorded.id, { amount: '21000.00' }, asAccounting()),
    );

    expect(corrected.amount).toBe('21000.00');
    expect(corrected.verificationStatus).toBe(PaymentVerificationStatus.VERIFIED);
  });
});

describe('accounting’s queue across trips', () => {
  it('lists what is waiting, oldest first, naming the trip and the client', async () => {
    if (!available) return;

    await collect('20000.00', { receivedAt: '2026-09-10T00:00:00.000Z' });
    await collect('5000.00', { receivedAt: '2026-08-11T00:00:00.000Z' });
    // Accounting's own is verified on the spot, so it is not work for anybody.
    await pay('1000.00');

    const queue = await payments.list({
      verificationStatus: PaymentVerificationStatus.UNVERIFIED,
    });

    const mine = queue.filter((row) => row.shipmentId === SHIPMENT_ID);
    expect(mine.map((row) => row.amount)).toEqual(['5000.00', '20000.00']);
    expect(mine[0]?.clientName).toBe('Payment Test Client');
    expect(mine[0]?.shipmentNumber).not.toBeNull();
  });
});
