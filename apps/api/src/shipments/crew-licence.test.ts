import { BadRequestException } from '@nestjs/common';
import { createPrismaClient, testUuid, withActor, type ExtendedPrismaClient } from '@eztruckr/db';
import { ShipmentStatus, StaffRole } from '@eztruckr/types';
import { StaffService } from '../master-data/staff.service';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * The licence rule on the driver slot, which the brief asks for and which had
 * NO test at all until somebody hit it in the app.
 *
 * The three refusals are separate on purpose — no number, no expiry, expired —
 * because they are three different things for the office to go and fix, and a
 * single "invalid licence" would send them looking at the wrong field. What is
 * pinned here is that each says which.
 *
 * IT ALSO PINS THE RESPONSE SHAPE, and that is half the point. `badRequest()`
 * leaves `error.message` as the generic 'Validation failed' and puts the real
 * sentence in `errors[]`. The web client read only the wrapper, so a driver
 * with no expiry on file produced a toast saying "Validation failed" and
 * nothing else — the API had the answer the whole time. Anything that flattens
 * `errors` away is what these assertions are guarding against.
 *
 * Block `00000009`.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let shipments: ShipmentsService;

let adminId: string;
let clientId: string;

const PREFIX = '00000009-';
const id = (name: string) => testUuid('00000009', name);

const CLEANUP_STATEMENTS = [
  `DELETE FROM "shipment" WHERE id::text LIKE '${PREFIX}%'`,
  `DELETE FROM "staff" WHERE id::text LIKE '${PREFIX}%'`,
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

/** A day either side of now, so "expired" needs no fixed date in the file. */
const daysFromNow = (days: number) => new Date(Date.now() + days * 86_400_000);

async function driver(
  key: string,
  licence: { licenseNumber: string | null; licenseExpiry: Date | null },
): Promise<string> {
  // AWAITED INSIDE the actor scope, not returned from it. A PrismaPromise is
  // lazy — it does not run until awaited — so handing it back unawaited starts
  // the query after `withActor` has exited, the audit extension sees no actor,
  // and `staff_created_by_required` rejects the row. Every other suite here
  // uses this shape; this one did not, and failed on the first run.
  await withActor({ userId: adminId }, async () => {
    await prisma.staff.create({
      data: {
        id: id(key),
        firstName: 'J M D',
        lastName: key,
        eligibleRoles: [StaffRole.DRIVER],
        ...licence,
      },
    });
  });

  return id(key);
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[crew-licence] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('The test database is not seeded — see prepareTestDatabase()');
  adminId = admin.id;

  shipments = new ShipmentsService({ client: prisma } as unknown as PrismaService);
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
      data: { id: id('client'), name: 'Crew Licence Test Client' },
    });
    clientId = client.id;

    await prisma.shipment.create({
      data: {
        id: id('shipment'),
        shipmentNumber: id('SHP').toUpperCase(),
        status: ShipmentStatus.DRAFT,
        clientId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '20000.0000',
      },
    });
  });
});

/** The `errors[]` array, which is where the usable sentence lives. */
async function refusal(driverId: string): Promise<{ path: string; message: string }[]> {
  try {
    await withActor({ userId: adminId }, () =>
      shipments.assignCrew(id('shipment'), { driverId, helperId: null }),
    );
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return (error.getResponse() as { errors?: { path: string; message: string }[] }).errors ?? [];
  }

  throw new Error('expected the assignment to be refused, and it was not');
}

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('a driver needs a current licence', () => {
  it('refuses one with no licence number, and says so', async () => {
    if (!available) return;

    const errors = await refusal(
      await driver('nonumber', {
        licenseNumber: null,
        licenseExpiry: null,
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('driverId');
    expect(errors[0]?.message).toMatch(/no licence number recorded/);
  });

  /**
   * THE CASE THAT WAS HIT IN THE APP: a number on file and no expiry. It reads
   * as "the licence is filled in" on the staff screen, and the driver slot
   * still refuses — so the message has to name the missing half.
   */
  it('refuses one with a number but no expiry, and names the expiry', async () => {
    if (!available) return;

    const errors = await refusal(
      await driver('noexpiry', {
        licenseNumber: 'N01-23-456789',
        licenseExpiry: null,
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('driverId');
    expect(errors[0]?.message).toMatch(/no licence expiry recorded/);
    // Not the other two refusals: they send somebody to the wrong field.
    expect(errors[0]?.message).not.toMatch(/no licence number/);
    expect(errors[0]?.message).not.toMatch(/expired on/);
  });

  it('refuses an expired one, and gives the date', async () => {
    if (!available) return;

    const errors = await refusal(
      await driver('expired', {
        licenseNumber: 'N02-19-334455',
        licenseExpiry: daysFromNow(-1),
      }),
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/licence expired on \d{4}-\d{2}-\d{2}/);
  });

  it('accepts one that is current', async () => {
    if (!available) return;

    const driverId = await driver('current', {
      licenseNumber: 'N03-20-112233',
      licenseExpiry: daysFromNow(365),
    });

    const shipment = await withActor({ userId: adminId }, () =>
      shipments.assignCrew(id('shipment'), { driverId, helperId: null }),
    );

    expect(shipment.driverId).toBe(driverId);
  });

  /**
   * The rule is the DRIVER SLOT's, not the person's. Somebody with no licence
   * at all is a perfectly good helper, and refusing them here would make the
   * check about who they are rather than what they are being asked to do.
   */
  it('does not ask a helper for one', async () => {
    if (!available) return;

    await withActor({ userId: adminId }, async () => {
      await prisma.staff.create({
        data: {
          id: id('helper'),
          firstName: 'Helper',
          lastName: 'J M D',
          eligibleRoles: [StaffRole.HELPER],
          licenseNumber: null,
          licenseExpiry: null,
        },
      });
    });

    const shipment = await withActor({ userId: adminId }, () =>
      shipments.assignCrew(id('shipment'), { driverId: null, helperId: id('helper') }),
    );

    expect(shipment.helperId).toBe(id('helper'));
  });
});

/**
 * The same rule on the way IN to the staff record, not just at assignment.
 *
 * `StaffService.update` re-applies it to the patch merged onto the stored row,
 * because a PATCH that only adds DRIVER eligibility carries no licence to judge
 * and one that only clears an expiry carries no roles. Both halves have to come
 * from the merge or the check is answering a question nobody asked.
 */
describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('the staff record demands it too', () => {
  it('refuses to make a helper driver-eligible with no expiry on file', async () => {
    if (!available) return;

    const staff = new StaffService({ client: prisma } as unknown as PrismaService);

    await withActor({ userId: adminId }, async () => {
      await prisma.staff.create({
        data: {
          id: id('promote'),
          firstName: 'Promoted',
          lastName: 'Helper',
          eligibleRoles: [StaffRole.HELPER],
          // A number but no expiry — the shape that used to save cleanly and
          // fail a screen later.
          licenseNumber: 'N04-21-998877',
          licenseExpiry: null,
        },
      });
    });

    const errors = await (async () => {
      try {
        await withActor({ userId: adminId }, () =>
          staff.update(id('promote'), { eligibleRoles: [StaffRole.DRIVER] }),
        );
      } catch (error) {
        if (!(error instanceof BadRequestException)) throw error;
        return (
          (error.getResponse() as { errors?: { path: string; message: string }[] }).errors ?? []
        );
      }
      throw new Error('expected the update to be refused, and it was not');
    })();

    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe('licenseExpiry');
    expect(errors[0]?.message).toMatch(/licence expiry date is required/);
  });

  it('allows the promotion once an expiry is supplied in the same patch', async () => {
    if (!available) return;

    const staff = new StaffService({ client: prisma } as unknown as PrismaService);

    await withActor({ userId: adminId }, async () => {
      await prisma.staff.create({
        data: {
          id: id('promote2'),
          firstName: 'Promoted',
          lastName: 'Helper Two',
          eligibleRoles: [StaffRole.HELPER],
          licenseNumber: 'N05-21-112244',
          licenseExpiry: null,
        },
      });
    });

    const updated = await withActor({ userId: adminId }, () =>
      staff.update(id('promote2'), {
        eligibleRoles: [StaffRole.DRIVER],
        licenseExpiry: daysFromNow(365).toISOString(),
      }),
    );

    expect(updated.eligibleRoles).toEqual([StaffRole.DRIVER]);
    expect(updated.licenseExpiry).not.toBeNull();
  });
});
