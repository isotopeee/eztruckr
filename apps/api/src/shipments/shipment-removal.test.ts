import {
  createPrismaClient,
  withActor,
  withDeleted,
  withTriggersSuspended,
  testUuid,
  type ExtendedPrismaClient,
} from '@eztruckr/db';
import {
  CrewRole,
  PaymentMethod,
  ShipmentStatus,
  UserRole,
  type CreateShipmentInput,
} from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestUser } from '../auth/request-user';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * Removing a trip, by both of the paths that can.
 *
 * THE FEATURE IS THE BOUNDARIES, not the delete. Soft-deleting a row is one
 * `updateMany` the extension already owns and there is nothing to get wrong
 * about it. What is worth pinning is where each path stops: dispatch at a draft
 * with nothing recorded against it, the administrator at money that has
 * actually been paid out — and, in between, that the administrator's removal
 * takes the trip's dependants with it rather than leaving them live in queues
 * that never look at the shipment.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let shipments: ShipmentsService;

let adminId: string;
let clientId: string;

/** Not `itest-`: see the note in liquidation-lifecycle.test.ts. */
const PREFIX = '0000000c-';
const id = (name: string) => testUuid('0000000c', name);

/**
 * The two callers, as the guard sees them.
 *
 * `remove` reads `role` and nothing else, so these are otherwise the same
 * person — which is the point: what separates the two paths below is the role
 * on the session, not who is signed in. The AUDIT actor stays the seeded
 * administrator throughout (`withActor`), because that is a different question
 * — who stamped the row — and there is one seeded user to stamp with.
 */
const administrator = { role: UserRole.ADMINISTRATOR } as RequestUser;
const dispatcher = { role: UserRole.OPERATIONS } as RequestUser;

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    // Matched through the shipment rather than by id prefix: the services mint
    // their own ids for everything below it. Every foreign key is Restrict, so
    // the order here is the order the rows depend on each other in.
    const ofOurShipments = `SELECT id FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%'`;

    await tx.$executeRawUnsafe(
      `DELETE FROM "commission" WHERE "shipmentId" IN (${ofOurShipments})`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "payout_line" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "payout_run" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM "additional_charge" WHERE "shipmentId" IN (${ofOurShipments})`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "client_payment" WHERE "shipmentId" IN (${ofOurShipments})`,
    );
    await tx.$executeRawUnsafe(
      `DELETE FROM "liquidation" WHERE "shipmentId" IN (${ofOurShipments})`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%'`);
    // After the shipments and the commissions, both of which name them.
    await tx.$executeRawUnsafe(`DELETE FROM "staff" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[shipment-removal] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  shipments = new ShipmentsService({ client: prisma } as unknown as PrismaService);

  await cleanup();
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!available) return;
  await cleanup();

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: id('client'), name: 'Removal Test Client' },
    });
    clientId = client.id;
  });
});

function booking(overrides: Partial<CreateShipmentInput> = {}): CreateShipmentInput {
  return {
    clientId,
    thirdPartyId: null,
    routeId: null,
    truckId: null,
    shipmentDate: null,
    origin: 'Manila',
    destination: 'Batangas',
    cargoDescription: null,
    containerNumber: null,
    grossRate: '50000.00',
    tpcRate: null,
    tpcAmount: null,
    ...overrides,
  };
}

async function book(overrides: Partial<CreateShipmentInput> = {}) {
  return withActor({ userId: adminId }, () => shipments.create(booking(overrides)));
}

async function remove(shipmentId: string, actor: RequestUser) {
  return withActor({ userId: adminId }, () => shipments.remove(shipmentId, actor));
}

async function dispatchIt(shipmentId: string): Promise<void> {
  // Straight to the column: `transition` would insist on a driver and a truck,
  // which is a different rule being tested somewhere else.
  await withActor({ userId: adminId }, async () => {
    await prisma.shipment.update({
      where: { id: shipmentId },
      data: { status: ShipmentStatus.DISPATCHED },
    });
  });
}

async function chargeIt(shipmentId: string, description: string): Promise<string> {
  return withActor({ userId: adminId }, async () => {
    const charge = await prisma.additionalCharge.create({
      data: { shipmentId, description, amount: '1500.00', isCommissionable: false },
    });

    return charge.id;
  });
}

/**
 * Cash actually handed to somebody for this trip.
 *
 * Written straight to the tables rather than driven through a payout service,
 * because what every guard reads is the `payoutLineId` column and never a run's
 * status — the same stand-in `shipment-booking.test.ts` uses. The run is left
 * DRAFT: reaching PAID would arm the triggers that refuse to unlink it, and the
 * cleanup has to be able to.
 */
async function payACommissionOn(shipmentId: string): Promise<void> {
  await withActor({ userId: adminId }, async () => {
    const driver = await prisma.staff.create({
      data: {
        id: id('driver'),
        firstName: 'Paid',
        lastName: 'Driver',
        eligibleRoles: [CrewRole.DRIVER],
      },
    });

    const run = await prisma.payoutRun.create({
      data: {
        id: id('run'),
        runNumber: id('run').toUpperCase(),
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-31T00:00:00.000Z'),
      },
    });

    const line = await prisma.payoutLine.create({
      data: {
        id: id('line'),
        payoutRunId: run.id,
        staffId: driver.id,
        grossAmount: '1000.0000',
        netAmount: '1000.0000',
      },
    });

    await prisma.commission.create({
      data: {
        shipmentId,
        staffId: driver.id,
        role: CrewRole.DRIVER,
        commissionableBase: '20000.0000',
        amount: '1000.0000',
        appliedRate: '0.0500',
        payoutLineId: line.id,
      },
    });
  });
}

describe('dispatch undoing a booking', () => {
  it('takes it out of every list and leaves the row behind, stamped', async () => {
    if (!available) return;

    const shipment = await book();

    await remove(shipment.id, dispatcher);

    await expect(shipments.get(shipment.id)).rejects.toThrow(/No shipment with id/);

    const page = await shipments.list({
      page: 1,
      pageSize: 25,
      search: shipment.shipmentNumber,
      sort: 'date',
      direction: 'desc',
    });
    expect(page.items).toHaveLength(0);

    // The row itself is still there, and says who removed it. That is the
    // whole difference between this and a DELETE, so it is asserted rather
    // than assumed from the absence above.
    //
    // `async` rather than a bare arrow, here and below: a Prisma promise is
    // lazy, so a callback that merely RETURNS one leaves the query to run
    // after the scope has closed, and the row stays hidden.
    const removed = await withDeleted(async () =>
      prisma.shipment.findFirst({ where: { id: shipment.id } }),
    );

    expect(removed?.deletedAt).toBeInstanceOf(Date);
    expect(removed?.deletedBy).toBe(adminId);
  });

  /**
   * A helper is named to a trip and an account opens for them in the same
   * write. It is empty, nobody has released anything into it, and refusing to
   * remove the trip because of it would make every booking with a helper on it
   * permanently unremovable — while leaving it behind would keep it in the
   * liquidation queue, which reads accounts directly rather than through the
   * shipment.
   */
  it('takes the trip’s empty cash accounts with it', async () => {
    if (!available) return;

    const shipment = await book();

    await withActor({ userId: adminId }, async () => {
      await prisma.staff.create({
        data: {
          id: id('helper'),
          firstName: 'Removal',
          lastName: 'Helper',
          eligibleRoles: [CrewRole.HELPER],
        },
      });

      await shipments.assignCrew(shipment.id, { driverId: null, helperId: id('helper') });
    });

    expect(await prisma.liquidation.count({ where: { shipmentId: shipment.id } })).toBe(1);

    await remove(shipment.id, dispatcher);

    expect(await prisma.liquidation.count({ where: { shipmentId: shipment.id } })).toBe(0);

    const account = await withDeleted(async () =>
      prisma.liquidation.findFirst({ where: { shipmentId: shipment.id } }),
    );
    expect(account?.deletedAt).toBeInstanceOf(Date);
  });

  /**
   * Dispatch's path stops at the yard gate, and the refusal has to say who CAN
   * do it — a 403 that only says no is how somebody concludes the feature is
   * broken and books a correcting trip instead.
   */
  it('refuses a dispatcher a trip that has been dispatched, and names who can', async () => {
    if (!available) return;

    const shipment = await book();
    await dispatchIt(shipment.id);

    await expect(remove(shipment.id, dispatcher)).rejects.toThrow(/administrator/);

    expect(await prisma.shipment.count({ where: { id: shipment.id } })).toBe(1);
  });

  /**
   * THE PROBE, NOT THE STATUS, is what catches this one — the trip is still a
   * DRAFT and would pass every check above it. A charge is a figure somebody
   * recorded about this trip and nothing else, so a trip carrying one is a trip
   * that started rather than a booking made in error.
   */
  it('refuses a draft that already has a charge on it, and names it', async () => {
    if (!available) return;

    const shipment = await book();
    await chargeIt(shipment.id, 'Detention');

    await expect(remove(shipment.id, dispatcher)).rejects.toThrow(/1 additional charge\(s\)/);

    expect(await prisma.shipment.count({ where: { id: shipment.id } })).toBe(1);
  });

  /**
   * A charge that was itself removed does not go on blocking the trip. The
   * probes are ordinary reads, so the extension's `deletedAt` filter is what
   * makes this true — which is worth a test, because it is the behaviour that
   * would silently invert if a probe ever reached for `withDeleted`.
   */
  it('allows removal once a mistaken charge has been removed too', async () => {
    if (!available) return;

    const shipment = await book();
    const chargeId = await chargeIt(shipment.id, 'Typed twice');

    await withActor({ userId: adminId }, async () => {
      await prisma.additionalCharge.softDelete({ id: chargeId });
    });

    await expect(remove(shipment.id, dispatcher)).resolves.toEqual({ removed: true });
  });
});

describe('an administrator removing a trip that has run', () => {
  /**
   * WHERE THE TWO PATHS DIVERGE. The same trip, in the same state, refused to
   * dispatch a few tests above and removed here — and removed WITH its
   * dependants, because past DRAFT refusing on the rows would refuse every
   * trip that ever ran.
   */
  it('takes the trip’s charges, payments and accounts with it', async () => {
    if (!available) return;

    const shipment = await book();
    await chargeIt(shipment.id, 'Detention');

    await withActor({ userId: adminId }, async () => {
      await prisma.clientPayment.create({
        data: {
          shipmentId: shipment.id,
          amount: '10000.00',
          receivedAt: new Date(),
          paymentMethod: PaymentMethod.BANK_TRANSFER,
        },
      });

      await prisma.staff.create({
        data: {
          id: id('helper'),
          firstName: 'Removal',
          lastName: 'Helper',
          eligibleRoles: [CrewRole.HELPER],
        },
      });

      await shipments.assignCrew(shipment.id, { driverId: null, helperId: id('helper') });
    });

    await dispatchIt(shipment.id);

    await expect(remove(shipment.id, administrator)).resolves.toEqual({ removed: true });

    // Each of these is read by something that never looks at the shipment —
    // the P&L, the payment verification queue, the liquidation queue — so a
    // row left live here is a queue entry pointing at a trip that is gone.
    expect(await prisma.shipment.count({ where: { id: shipment.id } })).toBe(0);
    expect(await prisma.additionalCharge.count({ where: { shipmentId: shipment.id } })).toBe(0);
    expect(await prisma.clientPayment.count({ where: { shipmentId: shipment.id } })).toBe(0);
    expect(await prisma.liquidation.count({ where: { shipmentId: shipment.id } })).toBe(0);

    // Removed, not destroyed — the same guarantee the draft path gives.
    const charge = await withDeleted(async () =>
      prisma.additionalCharge.findFirst({ where: { shipmentId: shipment.id } }),
    );
    expect(charge?.deletedAt).toBeInstanceOf(Date);
    expect(charge?.deletedBy).toBe(adminId);
  });

  /**
   * THE LINE NO ROLE CROSSES. A paid commission names a voucher somebody has
   * been handed, and the database says the same thing from underneath
   * (`paid_commission_no_soft_delete`) — this refuses first so the answer is a
   * sentence rather than a constraint name, and refuses BEFORE the cascade so
   * the trip is not left half-removed.
   */
  it('refuses once a commission on the trip has been paid', async () => {
    if (!available) return;

    const shipment = await book();
    await dispatchIt(shipment.id);
    await payACommissionOn(shipment.id);
    await chargeIt(shipment.id, 'Detention');

    await expect(remove(shipment.id, administrator)).rejects.toThrow(/already been paid/);

    expect(await prisma.shipment.count({ where: { id: shipment.id } })).toBe(1);
    // Nothing was taken on the way to the refusal.
    expect(await prisma.additionalCharge.count({ where: { shipmentId: shipment.id } })).toBe(1);
    expect(await prisma.commission.count({ where: { shipmentId: shipment.id } })).toBe(1);
  });
});
