import { createPrismaClient, withActor, type ExtendedPrismaClient, testUuid } from '@eztruckr/db';
import { ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * Truck assignment, and specifically the ways it is NOT crew assignment.
 *
 * Every rule here was chosen against the crew's equivalent rather than copied
 * from it, and each difference has a reason that is invisible at the call site:
 * a truck earns nothing, so no payout freezes it. Without these assertions the
 * obvious "consistency" fix — reach for `assertNothingPaid`, mirror the
 * LIQUIDATED cutoff — looks like tidying up and silently makes a roadside swap
 * impossible to record.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let shipments: ShipmentsService;

let adminId: string;
let clientId: string;
let activeTruckId: string;
let retiredTruckId: string;

/** Not `itest-`: see the note in liquidation-lifecycle.test.ts. */
const PREFIX = '00000004-';
const id = (name: string) => testUuid('00000004', name);

/**
 * Well-formed, and belonging to no row.
 *
 * Ids are `uuid` columns now, so a placeholder like 'no-such-truck' no longer
 * means "matches nothing" — it fails the cast before any row is compared, and
 * the service's own not-found message never runs. A reserved block keeps this
 * distinguishable from every suite's fixtures.
 */
const ABSENT_ID = 'ffffffff-0000-7000-8000-000000000000';

/** Named rather than indexed out of the list: each case makes its own shipments. */
const DELETE_SHIPMENTS = `DELETE FROM "shipment" WHERE id::text LIKE '${PREFIX}%'`;

const CLEANUP_STATEMENTS = [
  DELETE_SHIPMENTS,
  `DELETE FROM "truck" WHERE id::text LIKE '${PREFIX}%'`,
  `DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`,
];

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  try {
    for (const statement of CLEANUP_STATEMENTS) {
      await prisma.$executeRawUnsafe(statement);
    }
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
    console.warn('[truck-assignment] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  shipments = new ShipmentsService({ client: prisma } as unknown as PrismaService);

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: id('client'), name: 'Truck Test Client' },
    });
    clientId = client.id;

    const active = await prisma.truck.create({
      data: { id: id('active'), plateNumber: id('AAA-111').toUpperCase(), isActive: true },
    });
    activeTruckId = active.id;

    // Sold, or off the road. Still valid on history, not offered for new work.
    const retired = await prisma.truck.create({
      data: { id: id('retired'), plateNumber: id('ZZZ-999').toUpperCase(), isActive: false },
    });
    retiredTruckId = retired.id;
  });
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

let shipmentId: string;
let counter = 0;

async function shipmentAt(status: ShipmentStatus, truckId: string | null = null) {
  counter += 1;
  shipmentId = id(`shipment-${counter}`);

  await withActor({ userId: adminId }, async () => {
    await prisma.shipment.create({
      data: {
        id: shipmentId,
        shipmentNumber: id(`SHP-${counter}`).toUpperCase(),
        status,
        clientId,
        truckId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '20000.0000',
        netRate: '20000.0000',
      },
    });
  });

  return shipmentId;
}

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

/**
 * Asserts the field-level complaint, not the exception's own message.
 *
 * `badRequest` — the shape every cross-field refusal in this service uses —
 * throws `BadRequestException({ message: 'Validation failed', errors: [...] })`
 * so the web form can render the message beside the input that caused it.
 * `rejects.toThrow(/…/)` only ever sees "Validation failed", which passes for
 * any rejection at all and would assert nothing.
 */
async function expectFieldError(
  run: () => Promise<unknown>,
  path: string,
  pattern: RegExp,
): Promise<void> {
  await expect(run()).rejects.toThrow();

  try {
    await run();
  } catch (error) {
    const body = (error as { response?: { errors?: { path: string; message: string }[] } })
      .response;
    const field = body?.errors?.find((entry) => entry.path === path);

    expect(field, `no error reported against ${path}: ${JSON.stringify(body)}`).toBeDefined();
    expect(field?.message).toMatch(pattern);
  }
}

beforeEach(async () => {
  if (!available) return;
  await prisma.$executeRawUnsafe(DELETE_SHIPMENTS);
});

describe('assigning a truck', () => {
  it('attaches one to a draft, which is what makes dispatch possible at all', async () => {
    if (!available) return;

    const draft = await shipmentAt(ShipmentStatus.DRAFT);
    const updated = await act(async () => shipments.assignTruck(draft, { truckId: activeTruckId }));

    expect(updated.truckId).toBe(activeTruckId);
    expect(updated.truckPlateNumber).toBe(id('AAA-111').toUpperCase());
  });

  it('refuses a truck that has been retired from service', async () => {
    if (!available) return;

    const draft = await shipmentAt(ShipmentStatus.DRAFT);

    await expectFieldError(
      () => act(async () => shipments.assignTruck(draft, { truckId: retiredTruckId })),
      'truckId',
      /deactivated and cannot be assigned to new work/i,
    );
  });

  /**
   * `isActive` is not `deletedAt`. A trip that went out on a truck the company
   * has since sold must still be saveable, or every later correction to that
   * shipment is blocked by a fact about the truck's present rather than the
   * trip's past.
   */
  it('still saves a truck that was retired AFTER it was assigned', async () => {
    if (!available) return;

    const dispatched = await shipmentAt(ShipmentStatus.IN_TRANSIT, retiredTruckId);
    const updated = await act(async () =>
      shipments.assignTruck(dispatched, { truckId: retiredTruckId }),
    );

    expect(updated.truckId).toBe(retiredTruckId);
  });

  it('rejects a truck id that does not exist', async () => {
    if (!available) return;

    const draft = await shipmentAt(ShipmentStatus.DRAFT);

    await expectFieldError(
      () => act(async () => shipments.assignTruck(draft, { truckId: ABSENT_ID })),
      'truckId',
      /No truck with id/i,
    );
  });
});

describe('when a truck may still change — deliberately not the crew rule', () => {
  /**
   * THE POINT OF THIS FILE. The crew freeze once a commission is paid, because
   * the voucher names them. A truck is paid nothing and feeds no figure in the
   * commission chain, so a breakdown swapped at a roadside is a correction the
   * system has to accept — long after the crew have stopped being editable.
   */
  it('allows a swap on a trip that is already liquidated', async () => {
    if (!available) return;

    const liquidated = await shipmentAt(ShipmentStatus.LIQUIDATED, retiredTruckId);
    const updated = await act(async () =>
      shipments.assignTruck(liquidated, { truckId: activeTruckId }),
    );

    expect(updated.truckId).toBe(activeTruckId);
  });

  it('stops at CLOSED, where the trip becomes part of the record', async () => {
    if (!available) return;

    const closed = await shipmentAt(ShipmentStatus.CLOSED, activeTruckId);

    await expect(
      act(async () => shipments.assignTruck(closed, { truckId: retiredTruckId })),
    ).rejects.toThrow(/closed; the truck on it is now part of the record/i);
  });

  it('lets a draft be left without one', async () => {
    if (!available) return;

    const draft = await shipmentAt(ShipmentStatus.DRAFT, activeTruckId);
    const updated = await act(async () => shipments.assignTruck(draft, { truckId: null }));

    expect(updated.truckId).toBeNull();
  });

  /**
   * Dispatch asserted there was a truck. Clearing it afterwards would leave a
   * shipment on the road with nothing recorded as carrying it — and unlike an
   * unassigned draft, that is not a state anybody can act on.
   */
  it('refuses to leave a dispatched trip without one', async () => {
    if (!available) return;

    const dispatched = await shipmentAt(ShipmentStatus.DISPATCHED, activeTruckId);

    await expectFieldError(
      () => act(async () => shipments.assignTruck(dispatched, { truckId: null })),
      'truckId',
      /cannot be left without a truck/i,
    );
  });
});
