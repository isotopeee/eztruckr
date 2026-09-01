import {
  createPrismaClient,
  withActor,
  type ExtendedPrismaClient,
  testUuid,
  withTriggersSuspended,
} from '@eztruckr/db';
import {
  CrewRole,
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
  await withTriggersSuspended(prisma, async (tx) => {
    // Child rows are matched through the shipment rather than by id prefix:
    // the services generate cuids, so nothing below the shipment carries one.
    //
    // The commission and the payout line behind it come first and in that
    // order: the commission is what stands in for money already handed over
    // (see the client-change test), and every foreign key here is Restrict.
    await tx.$executeRawUnsafe(
      `DELETE FROM "commission" WHERE "shipmentId" IN (SELECT id FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%')`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "payout_line" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "payout_run" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(
      `DELETE FROM "liquidation" WHERE "shipmentId" IN (SELECT id FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%')`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%'`);
    // After the shipments and the commissions, both of which name them.
    await tx.$executeRawUnsafe(`DELETE FROM "staff" WHERE id::text LIKE '${PREFIX}%'`);
    // After the shipments, which name it. The rate-chain correction tests
    // create one, and its id and its name are both unique.
    await tx.$executeRawUnsafe(`DELETE FROM "third_party" WHERE id::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
  });
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
    // Null, not a date: the common booking says nothing and takes the column's
    // default, which is the path worth exercising here.
    shipmentDate: null,
    origin: 'Manila',
    destination: 'Batangas',
    cargoDescription: null,
    containerNumber: null,
    grossRate: '20000.00',
    tpcRate: null,
    tpcAmount: null,
    ...overrides,
  };
}

const book = (overrides?: Partial<CreateShipmentInput>) =>
  withActor({ userId: adminId }, () => shipments.create(booking(overrides)));

/**
 * Cash actually handed to somebody for this trip.
 *
 * Written straight to the tables rather than driven through the payout service,
 * because payout RUNS are not built yet and what every guard reads is the
 * `payoutLineId` column, never a run's status — the same stand-in the
 * adjustment tests use. The run is left DRAFT: reaching PAID would arm the
 * triggers that refuse to unlink it, and the cleanup has to be able to.
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
        // The default method is PERCENT_OF_BASE, and
        // `commission_rate_based_needs_rate` insists a rate-based row carries
        // the rate it was computed at. 5% of the base is the amount above.
        appliedRate: '0.0500',
        payoutLineId: line.id,
      },
    });
  });
}

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

/**
 * BOOKING OPENS NO ACCOUNT, and this is where that is pinned.
 *
 * It used to open one with nobody named to it. The row was real and the
 * reasoning was sound — a crew spends money from day one — but an account with
 * no custodian is not the same thing as a place to record spending: every trip
 * carried one whether anybody held its cash or not, releases landed on it
 * because it was the default, and that default is how a helper's ferry money
 * reached the row that later became the driver's.
 */
describe('booking opens no cash account', () => {
  it('creates the shipment and nothing else', async () => {
    if (!available) return;

    const shipment = await book();

    expect(await prisma.liquidation.count({ where: { shipmentId: shipment.id } })).toBe(0);
    expect(shipment.status).toBe(ShipmentStatus.DRAFT);
  });

  /**
   * The trip that reaches delivery having never been given one — nobody
   * assigned, nobody opened one by hand — and whose crew are now holding
   * receipts. This is the ONLY automatic unnamed account left in the system.
   */
  it('opens an unnamed one at delivery, for a trip that still has none', async () => {
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

    const opened = await prisma.liquidation.findMany({ where: { shipmentId: shipment.id } });

    expect(opened).toHaveLength(1);
    expect(opened[0]?.custodianId).toBeNull();
    expect(opened[0]?.sequence).toBe(1);
    expect(opened[0]?.status).toBe(LiquidationStatus.PENDING);
    // Not submitted, and the column says so. It used to be NOT NULL DEFAULT
    // now(), which claimed every liquidation had been submitted the moment it
    // came into existence.
    expect(opened[0]?.submittedAt).toBeNull();
  });

  /**
   * The trip that HAS an account by the time it is delivered. Adding an unnamed
   * one beside it would put the default back on the screen — a row with nobody
   * answerable for it, ready for the next release to drift onto.
   */
  it('adds none at delivery when the trip already has one', async () => {
    if (!available) return;

    const shipment = await book({ truckId: null });

    await withActor({ userId: adminId }, async () => {
      await prisma.liquidation.create({
        data: {
          shipmentId: shipment.id,
          sequence: 1,
          status: LiquidationStatus.PENDING,
        },
      });

      await prisma.shipment.update({
        where: { id: shipment.id },
        data: { status: ShipmentStatus.IN_TRANSIT },
      });

      await shipments.transition(shipment.id, {
        to: ShipmentStatus.DELIVERED,
        occurredAt: null,
      });
    });

    expect(await prisma.liquidation.count({ where: { shipmentId: shipment.id } })).toBe(1);
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
   * The MONEY half of the booking edit is NOT what moved. A dispatcher
   * correcting the cargo description of a trip on the road still gets the same
   * refusal it always got — the trip's identifying details opened up around it
   * (see the describe below), and the three rules stay legible only while this
   * and those pass together.
   */
  it('leaves the money half of the booking edit shut at DRAFT', async () => {
    if (!available) return;

    const shipment = await dispatched();

    await expect(
      withActor({ userId: adminId }, () =>
        shipments.update(shipment.id, { cargoDescription: 'Rice' }),
      ),
    ).rejects.toThrow(/can only be changed while it is a draft/i);

    // Named in the refusal, so the person reading it knows which field of the
    // several they submitted was the one that closed.
    await expect(
      withActor({ userId: adminId }, () => shipments.update(shipment.id, { grossRate: '9.00' })),
    ).rejects.toThrow(/grossRate/);
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

/**
 * The facts that IDENTIFY the trip stay correctable after dispatch.
 *
 * A THIRD RULE, not a relaxation of either of the two above. The client, the
 * date the trip ran, the route, the lane and the container number are
 * transcribed from paperwork that mostly arrives after the booking — nobody
 * committed to them the way they committed to a gross rate, and a trip filed
 * under the wrong client is one nobody can find. Refusing the correction does
 * not make the record true; it makes it permanently false.
 *
 * Two of them are not merely labels, and that is what most of this covers:
 * `resolveCommissionRule` scopes rules by client and route, so moving either
 * can hand the crew a different rate.
 */
describe('the trip’s own details stay correctable after dispatch', () => {
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

  it('accepts the container number, the date and the lane on a trip on the road', async () => {
    if (!available) return;

    const shipment = await dispatched();

    const corrected = await withActor({ userId: adminId }, () =>
      shipments.update(shipment.id, {
        containerNumber: 'TCLU1234567',
        shipmentDate: '2026-08-01T00:00:00.000Z',
        origin: 'Manila South Harbor',
        destination: 'Batangas Port',
      }),
    );

    expect(corrected.containerNumber).toBe('TCLU1234567');
    expect(corrected.shipmentDate).toBe('2026-08-01T00:00:00.000Z');
    expect(corrected.origin).toBe('Manila South Harbor');
  });

  /**
   * None of those three appears in `RuleScope`, so a computation that has
   * already run is still reproducible from the shipment beside it. Reporting
   * them stale would send somebody to recompute a payout that cannot change.
   */
  it('does not report computed commissions stale for a container correction', async () => {
    if (!available) return;

    const shipment = await dispatched();

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.update({
        where: { id: shipment.id },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    await withActor({ userId: adminId }, () =>
      shipments.update(shipment.id, { containerNumber: 'TCLU7654321' }),
    );

    expect(await shipments.isComputationStale(shipment.id)).toBe(false);
  });

  /**
   * The client DOES appear in `RuleScope`, so this one has to go the other way.
   * The stored commissions were resolved against the old client and no longer
   * follow from the shipment, which is exactly what the flag announces.
   */
  it('reports them stale when the client moves, because it re-scopes the rules', async () => {
    if (!available) return;

    const shipment = await dispatched();

    const other = await withActor({ userId: adminId }, async () =>
      prisma.client.create({ data: { id: id('client2'), name: 'Corrected Client' } }),
    );

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.update({
        where: { id: shipment.id },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    await withActor({ userId: adminId }, () =>
      shipments.update(shipment.id, { clientId: other.id }),
    );

    expect(await shipments.isComputationStale(shipment.id)).toBe(true);
  });

  /**
   * Re-saving a form nobody changed is not a change. Without the comparison
   * against what is stored, opening the dialog and pressing save would report
   * every computed commission on the trip stale.
   */
  it('leaves the computation alone when the client is re-sent unchanged', async () => {
    if (!available) return;

    const shipment = await dispatched();

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.update({
        where: { id: shipment.id },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    await withActor({ userId: adminId }, () =>
      shipments.update(shipment.id, { clientId, routeId: null, containerNumber: 'ABCD1234567' }),
    );

    expect(await shipments.isComputationStale(shipment.id)).toBe(false);
  });

  /**
   * The bound that is not a status. A paid commission names a voucher that has
   * to keep reconciling, so the client cannot move underneath it — the same
   * line that governs a late charge and a rate correction.
   */
  it('refuses a client change once a commission has been paid', async () => {
    if (!available) return;

    const shipment = await dispatched();

    const other = await withActor({ userId: adminId }, async () =>
      prisma.client.create({ data: { id: id('client3'), name: 'Too Late Client' } }),
    );

    await payACommissionOn(shipment.id);

    await expect(
      withActor({ userId: adminId }, () => shipments.update(shipment.id, { clientId: other.id })),
    ).rejects.toThrow(/already been paid/i);

    // The container number is not scoped by any rule, so the paid commission
    // has no claim on it and the correction still lands.
    const corrected = await withActor({ userId: adminId }, () =>
      shipments.update(shipment.id, { containerNumber: 'PAID1234567' }),
    );

    expect(corrected.containerNumber).toBe('PAID1234567');
  });

  /**
   * LIQUIDATED closes the trip's record for good — the same bound as the
   * charges and the rate correction, because it is the same reason.
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
        shipments.update(shipment.id, { containerNumber: 'LATE1234567' }),
      ),
    ).rejects.toThrow(/part of the settled record/i);
  });
});
