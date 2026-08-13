import { CrewRole, ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from './actor-context';
import type { ExtendedPrismaClient } from './prisma-client';
import { withDeleted } from './soft-delete-context';
import { cleanupTestRows, createTestClient, databaseIsReachable, testId } from './test-support';

/**
 * The soft-delete filter is the piece most likely to fail silently: a missed
 * filter does not throw, it just quietly includes a row that should be gone.
 * These tests exercise the paths a hand-written filter would most plausibly
 * miss — nested collections, aggregates, and recreate-after-delete.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let adminId: string;
let clientId: string;

beforeAll(async () => {
  prisma = createTestClient();
  available = await databaseIsReachable(prisma);
  if (!available) {
    console.warn('[soft-delete] database unreachable — skipping integration tests');
    return;
  }

  await cleanupTestRows(prisma);

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: testId('sd-client'), code: testId('SD-CLT'), name: 'Soft Delete Test Client' },
    });
    clientId = client.id;
  });
});

afterAll(async () => {
  if (available) await cleanupTestRows(prisma);
  await prisma.$disconnect();
});

async function createShipment(suffix: string) {
  return withActor({ userId: adminId }, async () =>
    prisma.shipment.create({
      data: {
        id: testId(`sd-shipment-${suffix}`),
        shipmentNumber: testId(`SD-SHP-${suffix}`),
        status: ShipmentStatus.DRAFT,
        clientId,
        origin: 'Manila',
        destination: 'Clark',
        grossRate: '15000.0000',
      },
    }),
  );
}

describe('soft delete filtering', () => {
  it('hides deleted rows from findMany, findFirst and count', async () => {
    if (!available) return;
    const shipment = await createShipment('hide');

    expect(await prisma.shipment.findFirst({ where: { id: shipment.id } })).not.toBeNull();
    const before = await prisma.shipment.count({ where: { clientId } });

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.softDelete({ id: shipment.id }),
    );

    expect(await prisma.shipment.findFirst({ where: { id: shipment.id } })).toBeNull();
    expect(await prisma.shipment.findMany({ where: { id: shipment.id } })).toHaveLength(0);
    expect(await prisma.shipment.count({ where: { clientId } })).toBe(before - 1);
  });

  it('hides deleted rows from findUnique as well', async () => {
    if (!available) return;
    const shipment = await createShipment('unique');
    await withActor({ userId: adminId }, async () =>
      prisma.shipment.softDelete({ id: shipment.id }),
    );

    // findUnique is the easy one to overlook, since its where takes a key.
    expect(await prisma.shipment.findUnique({ where: { id: shipment.id } })).toBeNull();
  });

  it('stamps deletedAt and deletedBy, and leaves them alone on a second delete', async () => {
    if (!available) return;
    const shipment = await createShipment('stamp');

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.softDelete({ id: shipment.id }),
    );

    const first = await withDeleted(async () =>
      prisma.shipment.findFirst({ where: { id: shipment.id } }),
    );
    expect(first?.deletedAt).toBeInstanceOf(Date);
    expect(first?.deletedBy).toBe(adminId);

    const affected = await withActor({ userId: adminId }, async () =>
      prisma.shipment.softDelete({ id: shipment.id }),
    );
    expect(affected).toBe(0);

    const second = await withDeleted(async () =>
      prisma.shipment.findFirst({ where: { id: shipment.id } }),
    );
    expect(second?.deletedAt?.getTime()).toBe(first?.deletedAt?.getTime());
  });

  it('filters deleted children out of a nested include', async () => {
    if (!available) return;
    const shipment = await createShipment('nested');

    await withActor({ userId: adminId }, async () => {
      await prisma.additionalCharge.create({
        data: {
          id: testId('sd-charge-live'),
          shipmentId: shipment.id,
          description: 'Extra drop fee',
          amount: '1500.0000',
        },
      });
      await prisma.additionalCharge.create({
        data: {
          id: testId('sd-charge-dead'),
          shipmentId: shipment.id,
          description: 'Cancelled surcharge',
          amount: '900.0000',
        },
      });
    });

    await withActor({ userId: adminId }, async () =>
      prisma.additionalCharge.softDelete({ id: testId('sd-charge-dead') }),
    );

    // `include: { additionalCharges: true }` has no where clause of its own —
    // this is exactly where a deleted charge would sneak back into a total.
    const withCharges = await prisma.shipment.findFirst({
      where: { id: shipment.id },
      include: { additionalCharges: true },
    });

    expect(withCharges?.additionalCharges).toHaveLength(1);
    expect(withCharges?.additionalCharges[0]?.id).toBe(testId('sd-charge-live'));
  });

  it('lets withDeleted see deleted rows, top level and nested', async () => {
    if (!available) return;

    const seen = await withDeleted(async () =>
      prisma.shipment.findFirst({
        where: { id: testId('sd-shipment-nested') },
        include: { additionalCharges: true },
      }),
    );

    expect(seen).not.toBeNull();
    expect(seen?.additionalCharges).toHaveLength(2);
  });

  it('respects an explicit deletedAt filter over the default', async () => {
    if (!available) return;

    const onlyDeleted = await prisma.shipment.findMany({
      where: { clientId, deletedAt: { not: null } },
    });

    expect(onlyDeleted.length).toBeGreaterThan(0);
    expect(onlyDeleted.every((row) => row.deletedAt !== null)).toBe(true);
  });

  it('restores a deleted row', async () => {
    if (!available) return;
    const shipment = await createShipment('restore');

    await withActor({ userId: adminId }, async () =>
      prisma.shipment.softDelete({ id: shipment.id }),
    );
    expect(await prisma.shipment.findFirst({ where: { id: shipment.id } })).toBeNull();

    const restored = await prisma.shipment.restore({ id: shipment.id });
    expect(restored).toBe(1);

    const back = await prisma.shipment.findFirst({ where: { id: shipment.id } });
    expect(back).not.toBeNull();
    expect(back?.deletedAt).toBeNull();
    expect(back?.deletedBy).toBeNull();
  });

  it('refuses a hard delete unless explicitly permitted', async () => {
    if (!available) return;
    const shipment = await createShipment('hard');

    await expect(prisma.shipment.delete({ where: { id: shipment.id } })).rejects.toThrow(
      /Hard delete is not permitted/i,
    );
    await expect(prisma.shipment.deleteMany({ where: { id: shipment.id } })).rejects.toThrow(
      /Hard delete is not permitted/i,
    );

    // Still there.
    expect(await prisma.shipment.findFirst({ where: { id: shipment.id } })).not.toBeNull();
  });
});

describe('partial unique constraints', () => {
  it('frees a natural key once the row is deleted, so it can be reused', async () => {
    if (!available) return;
    const code = testId('REUSE-CLT');

    const first = await withActor({ userId: adminId }, async () =>
      prisma.client.create({ data: { id: testId('reuse-1'), code, name: 'First' } }),
    );

    // A full unique would reserve this code forever.
    await withActor({ userId: adminId }, async () => prisma.client.softDelete({ id: first.id }));

    const second = await withActor({ userId: adminId }, async () =>
      prisma.client.create({ data: { id: testId('reuse-2'), code, name: 'Second' } }),
    );

    expect(second.id).not.toBe(first.id);
    expect(await prisma.client.findMany({ where: { code } })).toHaveLength(1);
    expect(await withDeleted(async () => prisma.client.findMany({ where: { code } }))).toHaveLength(
      2,
    );
  });

  it('still rejects two live rows sharing a natural key', async () => {
    if (!available) return;
    const code = testId('DUP-CLT');

    await withActor({ userId: adminId }, async () =>
      prisma.client.create({ data: { id: testId('dup-1'), code, name: 'First' } }),
    );

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.client.create({ data: { id: testId('dup-2'), code, name: 'Second' } }),
      ),
    ).rejects.toThrow();
  });
});

describe('isActive is not soft delete', () => {
  it('keeps a deactivated row visible and usable on history', async () => {
    if (!available) return;

    const truck = await withActor({ userId: adminId }, async () =>
      prisma.truck.create({
        data: { id: testId('sd-truck'), plateNumber: testId('SD-PLT'), isActive: false },
      }),
    );

    // Deactivated means "not offered for new entries", not "gone".
    const found = await prisma.truck.findFirst({ where: { id: truck.id } });
    expect(found).not.toBeNull();
    expect(found?.isActive).toBe(false);
    expect(found?.deletedAt).toBeNull();

    // And the two are filtered independently.
    const offered = await prisma.truck.findMany({ where: { isActive: true } });
    expect(offered.some((row) => row.id === truck.id)).toBe(false);
  });
});

describe('code CHECK constraints', () => {
  it('rejects a status outside the code set', async () => {
    if (!available) return;

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.shipment.create({
          data: {
            id: testId('sd-badcode'),
            shipmentNumber: testId('SD-BAD'),
            // 99 is not an allocated ShipmentStatus. Deliberately a raw number:
            // the point is that the database refuses it.
            status: 99,
            clientId,
            origin: 'Manila',
            destination: 'Clark',
            grossRate: '15000.0000',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  /**
   * The gas rate override and its reason must travel together.
   *
   * This pair used to be one column plus a convention: `appliedGasDeductionRate`
   * held both the requested rate and the frozen result, and the reason string
   * was the only thing distinguishing them. No CHECK could enforce that,
   * because the database had the same missing information — so an override
   * written without a reason would silently read as a frozen default and be
   * overwritten on the next recompute, paying the crew a different figure.
   *
   * Splitting the input from the output made the rule expressible. These two
   * assertions are what "structural rather than conventional" actually buys:
   * the guarantee now holds against raw SQL, not just against the one endpoint
   * that happens to validate it.
   */
  it('refuses a gas rate override with no reason', async () => {
    if (!available) return;

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.shipment.create({
          data: {
            id: testId('sd-override-noreason'),
            shipmentNumber: testId('SD-ONR'),
            clientId,
            origin: 'Manila',
            destination: 'Clark',
            grossRate: '15000.0000',
            gasRateOverride: '0.3000',
            gasRateOverrideReason: null,
          },
        }),
      ),
    ).rejects.toThrow(/gas_rate_override_needs_reason/i);
  });

  it('refuses a reason with no gas rate override', async () => {
    if (!available) return;

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.shipment.create({
          data: {
            id: testId('sd-reason-norate'),
            shipmentNumber: testId('SD-RNR'),
            clientId,
            origin: 'Manila',
            destination: 'Clark',
            grossRate: '15000.0000',
            gasRateOverride: null,
            gasRateOverrideReason: 'orphaned explanation',
          },
        }),
      ),
    ).rejects.toThrow(/gas_rate_override_needs_reason/i);
  });

  it('leaves the frozen applied rate free of that pairing rule', async () => {
    if (!available) return;

    // The output column is written by the engine on every computation,
    // including the ordinary case where no override existed. Tying it to a
    // reason would make the common path impossible.
    const shipment = await withActor({ userId: adminId }, async () =>
      prisma.shipment.create({
        data: {
          id: testId('sd-frozen-default'),
          shipmentNumber: testId('SD-FRZ'),
          clientId,
          origin: 'Manila',
          destination: 'Clark',
          grossRate: '15000.0000',
          appliedGasDeductionRate: '0.2500',
        },
      }),
    );

    expect(shipment.appliedGasDeductionRate?.toString()).toBe('0.25');
    expect(shipment.gasRateOverride).toBeNull();
    expect(shipment.gasRateOverrideReason).toBeNull();
  });

  it('rejects an invalid crew role inside the eligibleRoles array', async () => {
    if (!available) return;

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.staff.create({
          data: {
            id: testId('sd-badrole'),
            staffCode: testId('SD-BADROLE'),
            firstName: 'Bad',
            lastName: 'Role',
            eligibleRoles: [CrewRole.DRIVER, 42],
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
