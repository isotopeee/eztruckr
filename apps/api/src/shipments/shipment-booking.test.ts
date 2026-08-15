import { createPrismaClient, withActor, type ExtendedPrismaClient, testUuid } from '@eztruckr/db';
import {
  LiquidationStatus,
  shipmentNumberDatePart,
  ShipmentStatus,
  type CreateShipmentInput,
} from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * What happens when a trip is BOOKED: it is numbered, and it gets the
 * liquidation it will need.
 *
 * Both are new in this phase and both replace something that used to be
 * somebody's job — typing a unique number, and remembering that the crew have
 * nowhere to record spending until the office marks the trip delivered.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let shipments: ShipmentsService;

let adminId: string;
let clientId: string;

/** Not `itest-`: see the note in liquidation-lifecycle.test.ts. */
const PREFIX = '00000003-';
const id = (name: string) => testUuid('00000003', name);

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  try {
    // Child rows are matched through the shipment rather than by id prefix:
    // the services generate cuids, so nothing below the shipment carries one.
    await prisma.$executeRawUnsafe(
      `DELETE FROM "liquidation" WHERE "shipmentId" IN (SELECT id FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%'`,
    );
    // After the shipments, which name it. The rate-chain correction tests
    // create one, and its id and its name are both unique.
    await prisma.$executeRawUnsafe(`DELETE FROM "third_party" WHERE id::text LIKE '${PREFIX}%'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
  } finally {
    await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
  }
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[shipment-booking] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  shipments = new ShipmentsService({ client: prisma } as unknown as PrismaService);

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: id('client'), name: 'Booking Test Client' },
    });
    clientId = client.id;
  });
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
      data: { id: id('client'), name: 'Booking Test Client' },
    });
  });
});

function booking(overrides: Partial<CreateShipmentInput> = {}): CreateShipmentInput {
  return {
    clientId,
    thirdPartyId: null,
    routeId: null,
    truckId: null,
    origin: 'Manila',
    destination: 'Batangas',
    cargoDescription: null,
    grossRate: '20000.00',
    tpcRate: null,
    tpcAmount: null,
    ...overrides,
  };
}

const book = (overrides?: Partial<CreateShipmentInput>) =>
  withActor({ userId: adminId }, () => shipments.create(booking(overrides)));

describe('the shipment number is generated', () => {
  it('is today’s Manila date followed by 001 for the day’s first trip', async () => {
    if (!available) return;

    const today = shipmentNumberDatePart(new Date());
    const shipment = await book();

    // Not asserted as an exact string: the sequence depends on what else was
    // booked today, and a test that owned the whole day's numbering would
    // break the moment somebody used the app.
    expect(shipment.shipmentNumber).toMatch(new RegExp(`^${today}\\d{3,}$`));
  });

  it('counts up, and never issues the same number twice', async () => {
    if (!available) return;

    const first = await book();
    const second = await book();
    const third = await book();

    expect(new Set([first, second, third].map((row) => row.shipmentNumber)).size).toBe(3);
    expect(Number(second.shipmentNumber)).toBe(Number(first.shipmentNumber) + 1);
    expect(Number(third.shipmentNumber)).toBe(Number(second.shipmentNumber) + 1);
  });

  /**
   * THE RACE. Two bookings landing together compute the same next number, and
   * the partial unique index refuses the loser. The person who clicked second
   * did nothing wrong, so the create retries rather than showing them an index
   * name — and this is the only test that can tell a working retry from a
   * fluke of timing.
   */
  it('survives concurrent bookings, giving each a distinct number', async () => {
    if (!available) return;

    const booked = await Promise.all([book(), book(), book(), book(), book()]);
    const numbers = booked.map((row) => row.shipmentNumber);

    expect(new Set(numbers).size).toBe(5);
  });

  /**
   * A soft-deleted trip keeps its number out of circulation. The trip may be
   * gone from here, but not from whatever left the building with that number
   * printed on it, and two trips behind one label is worse than a gap.
   */
  it('does not reissue the number of a soft-deleted trip', async () => {
    if (!available) return;

    const first = await book();
    await prisma.shipment.softDelete({ id: first.id });

    const second = await book();

    expect(second.shipmentNumber).not.toBe(first.shipmentNumber);
    expect(Number(second.shipmentNumber)).toBeGreaterThan(Number(first.shipmentNumber));
  });
});

describe('the liquidation exists from the booking', () => {
  it('is created with the shipment, at PENDING', async () => {
    if (!available) return;

    const shipment = await book();
    const liquidation = await prisma.liquidation.findFirst({
      where: { shipmentId: shipment.id },
    });

    expect(liquidation).not.toBeNull();
    expect(liquidation?.status).toBe(LiquidationStatus.PENDING);
    // Not submitted, and the column says so. It used to be NOT NULL DEFAULT
    // now(), which claimed every liquidation had been submitted the moment it
    // came into existence — now more visibly wrong, since that moment is the
    // booking.
    expect(liquidation?.submittedAt).toBeNull();
  });

  it('leaves the shipment a draft — the liquidation is waiting, not owed', async () => {
    if (!available) return;

    const shipment = await book();

    expect(shipment.status).toBe(ShipmentStatus.DRAFT);
  });

  /**
   * Every draft now has a PENDING liquidation, so PENDING alone has stopped
   * meaning "the crew owe us paperwork". Without the draft exclusion, every
   * unbooked trip would sit in accounting's queue and in the crew portal's.
   */
  it('keeps a draft out of the liquidation work queue', async () => {
    if (!available) return;

    const shipment = await book();

    const queued = await prisma.liquidation.findMany({
      where: {
        status: LiquidationStatus.PENDING,
        shipment: { status: { not: ShipmentStatus.DRAFT } },
      },
      select: { shipmentId: true },
    });

    expect(queued.map((row) => row.shipmentId)).not.toContain(shipment.id);
  });

  /**
   * The delivery path still calls `ensurePendingLiquidation`, as a backstop for
   * trips booked before creation started doing it. It must find the existing
   * row rather than create a second one — the partial unique index would
   * refuse anyway, and inside a transaction that failure would abort the
   * delivery it was riding along with.
   */
  it('is not duplicated when the trip is later delivered', async () => {
    if (!available) return;

    const shipment = await book({ truckId: null });

    await withActor({ userId: adminId }, async () => {
      // Straight to delivered through the database: this test is about the
      // liquidation, not about the dispatch preconditions.
      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.IN_TRANSIT },
      });

      await shipments.transition(shipment.id, {
        to: ShipmentStatus.DELIVERED,
        occurredAt: null,
      });
    });

    const count = await prisma.liquidation.count({ where: { shipmentId: shipment.id } });

    expect(count).toBe(1);
  });
});

/**
 * Correcting an agreed figure after the trip has left DRAFT.
 *
 * A SECOND ENDPOINT, not a relaxed lock, and these tests exist to keep the two
 * apart. `update` is the booking form and still shuts at DRAFT; `updateRateChain`
 * is for a rate that was agreed and recorded wrong, and outlives dispatch
 * because refusing it would leave the trip's revenue knowingly false for ever.
 * Merging them hands every dispatcher a lever on the commission base of work
 * already done — the role split is `CAN_EDIT_RATE_CHAIN`, enforced at the route.
 */
describe('the rate chain stays correctable after dispatch', () => {
  const dispatched = async (overrides?: Partial<CreateShipmentInput>) => {
    const shipment = await book(overrides);

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.IN_TRANSIT },
      }),
    );

    return shipment;
  };

  it('re-derives the whole chain from the corrected gross', async () => {
    if (!available) return;

    const shipment = await dispatched();

    const corrected = await withActor({ userId: adminId }, () =>
      shipments.updateRateChain(shipment.id, { grossRate: '25000.00' }),
    );

    expect(corrected.grossRate).toBe('25000');
    // Nothing is edited in isolation: the net follows the gross, every time.
    expect(corrected.netRate).toBe('25000');
  });

  /**
   * The booking edit is NOT what moved. A dispatcher correcting the cargo
   * description of a trip on the road still gets the same refusal it always
   * got, and the two rules stay legible only while this passes.
   */
  it('leaves the booking edit shut at DRAFT', async () => {
    if (!available) return;

    const shipment = await dispatched();

    await expect(
      withActor({ userId: adminId }, () =>
        shipments.update(shipment.id, { cargoDescription: 'Rice' }),
      ),
    ).rejects.toThrow(/can only be changed while it is a draft/i);
  });

  /**
   * A cut belongs to the broker it was agreed with. Carrying the previous
   * broker's figure across to a new one would be inventing a number, and
   * silently zeroing it would be inventing a different one — so the correction
   * refuses until somebody says what was actually agreed.
   */
  it('refuses a new broker without the cut agreed with them', async () => {
    if (!available) return;

    // Awaited INSIDE the scope: the audit extension runs over
    // AsyncLocalStorage and never sees a `PrismaPromise` awaited outside it,
    // which surfaces as `third_party_created_by_required` rather than as
    // anything about actors.
    const broker = await withActor({ userId: adminId }, async () =>
      prisma.thirdParty.create({ data: { id: id('broker'), name: 'Rate Chain Broker' } }),
    );

    const shipment = await dispatched();

    await expect(
      withActor({ userId: adminId }, () =>
        shipments.updateRateChain(shipment.id, { thirdPartyId: broker.id }),
      ),
    ).rejects.toMatchObject({
      response: {
        errors: [{ path: 'tpcRate', message: expect.stringContaining('name the cut agreed with') }],
      },
    });

    // Stated, and it lands.
    const corrected = await withActor({ userId: adminId }, () =>
      shipments.updateRateChain(shipment.id, { thirdPartyId: broker.id, tpcRate: '0.1000' }),
    );

    expect(corrected.tpcAmount).toBe('2000');
    expect(corrected.netRate).toBe('18000');
    expect(corrected.appliedTpcRate).toBe('0.1');
  });

  /**
   * LIQUIDATED means every account was approved against these figures. The
   * harder bound is not a status at all — a PAID commission stops a correction
   * through `assertNothingPaid`, the same line that governs a late charge.
   */
  it('is refused once the trip is liquidated', async () => {
    if (!available) return;

    const shipment = await book();

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.LIQUIDATED },
      }),
    );

    await expect(
      withActor({ userId: adminId }, () =>
        shipments.updateRateChain(shipment.id, { grossRate: '25000.00' }),
      ),
    ).rejects.toThrow(/part of the settled record/i);
  });

  /**
   * THE REASON `rateChainUpdatedAt` EXISTS. Without it a correction after a
   * computation leaves the stored commissions quietly disagreeing with the base
   * they were derived from, and nothing on the screen says so — the shipment's
   * own `updatedAt` cannot stand in, because swapping a truck moves it too.
   */
  it('reports the computed commissions stale afterwards', async () => {
    if (!available) return;

    const shipment = await dispatched();

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.update({
        where: { id: shipment.id },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    expect(await shipments.isComputationStale(shipment.id)).toBe(false);

    await withActor({ userId: adminId }, () =>
      shipments.updateRateChain(shipment.id, { grossRate: '25000.00' }),
    );

    expect(await shipments.isComputationStale(shipment.id)).toBe(true);
  });
});
