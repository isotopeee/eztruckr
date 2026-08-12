import { CommissionMethod, CrewRole, PayoutRunStatus, ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from './actor-context';
import type { ExtendedPrismaClient } from './prisma-client';
import { withDeleted, withHardDelete } from './soft-delete-context';
import { cleanupTestRows, createTestClient, databaseIsReachable, testId } from './test-support';

/**
 * THE load-bearing assertion of the payout model:
 *
 *   "A commission included in a paid run can never be paid again."
 *
 * Soft delete is what makes this genuinely hard. The unique index on
 * (shipmentId, role) is PARTIAL — it only covers live rows — so if a paid
 * commission could be soft-deleted, its slot would open up, a replacement
 * could be computed for the same trip and role, and the same work would be
 * paid twice. The original row would still read as paid, so nothing would
 * look wrong in any report.
 *
 * These tests hit a real database, because the guarantee is enforced by
 * constraints and triggers rather than by application code.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let adminId: string;
let clientId: string;
let crewMemberId: string;

beforeAll(async () => {
  prisma = createTestClient();
  available = await databaseIsReachable(prisma);

  if (!available) {
    console.warn('[payout-idempotency] database unreachable — skipping integration tests');
    return;
  }

  await cleanupTestRows(prisma);

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: testId('client'), code: testId('CLT'), name: 'Integration Test Client' },
    });
    clientId = client.id;

    const crew = await prisma.crewMember.create({
      data: {
        id: testId('crew'),
        employeeCode: testId('CRW'),
        firstName: 'Test',
        lastName: 'Driver',
        eligibleRoles: [CrewRole.DRIVER],
      },
    });
    crewMemberId = crew.id;
  });
});

afterAll(async () => {
  if (available) await cleanupTestRows(prisma);
  await prisma.$disconnect();
});

/** Builds a shipment with one driver commission, paid through a PAID run. */
async function createPaidCommission(suffix: string) {
  return withActor({ userId: adminId }, async () => {
    const shipment = await prisma.shipment.create({
      data: {
        id: testId(`shipment-${suffix}`),
        shipmentNumber: testId(`SHP-${suffix}`),
        status: ShipmentStatus.CLOSED,
        clientId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '18000.0000',
        tpcAmount: '1800.0000',
        netRate: '16200.0000',
        commissionableBase: '12150.0000',
      },
    });

    const run = await prisma.payoutRun.create({
      data: {
        id: testId(`run-${suffix}`),
        runNumber: testId(`RUN-${suffix}`),
        status: PayoutRunStatus.DRAFT,
        periodStart: new Date('2026-01-01T00:00:00Z'),
        periodEnd: new Date('2026-01-31T00:00:00Z'),
      },
    });

    const line = await prisma.payoutLine.create({
      data: {
        id: testId(`line-${suffix}`),
        payoutRunId: run.id,
        crewMemberId,
        grossAmount: '1822.5000',
        netAmount: '1822.5000',
      },
    });

    const commission = await prisma.commission.create({
      data: {
        id: testId(`commission-${suffix}`),
        shipmentId: shipment.id,
        crewMemberId,
        role: CrewRole.DRIVER,
        appliedMethod: CommissionMethod.PERCENT_OF_BASE,
        commissionableBase: '12150.0000',
        appliedRate: '0.1500',
        amount: '1822.5000',
        payoutLineId: line.id,
      },
    });

    // Pay the run last: every guard keys off this transition.
    await prisma.payoutRun.update({
      where: { id: run.id },
      data: { status: PayoutRunStatus.PAID, paidAt: new Date(), paidBy: adminId },
    });

    return { shipment, run, line, commission };
  });
}

describe.runIf(process.env.SKIP_DB_TESTS !== '1')('payout idempotency survives soft delete', () => {
  it('refuses to soft-delete a commission that has been paid', async () => {
    if (!available) return;
    const { commission } = await createPaidCommission('a');

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.softDelete({ id: commission.id }),
      ),
    ).rejects.toThrow(/has been paid and cannot be deleted/i);

    // And it is genuinely still live, not half-deleted.
    const stillThere = await prisma.commission.findFirst({ where: { id: commission.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('refuses a soft delete issued as raw SQL, not just through the client', async () => {
    if (!available) return;
    const { commission } = await createPaidCommission('b');

    // The extension is convenience; the trigger is the actual guarantee.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "commission" SET "deletedAt" = now() WHERE id = '${commission.id}'`,
      ),
    ).rejects.toThrow(/has been paid and cannot be deleted/i);
  });

  it('keeps a paid commission occupying its payout line, so it cannot be re-paid', async () => {
    if (!available) return;
    const { commission, run } = await createPaidCommission('c');

    const secondLine = await withActor({ userId: adminId }, async () =>
      prisma.payoutLine.create({
        data: {
          id: testId('line-c2'),
          payoutRunId: run.id,
          crewMemberId,
          grossAmount: '1822.5000',
          netAmount: '1822.5000',
        },
      }),
    );

    // Moving the paid commission onto a fresh line is the direct re-pay route.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.update({
          where: { id: commission.id },
          data: { payoutLineId: secondLine.id },
        }),
      ),
    ).rejects.toThrow(/cannot be re-paid/i);

    // Releasing it back to unpaid is the indirect route.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.update({
          where: { id: commission.id },
          data: { payoutLineId: null },
        }),
      ),
    ).rejects.toThrow(/cannot be re-paid/i);
  });

  it('blocks the delete-then-recreate route to paying the same work twice', async () => {
    if (!available) return;
    const { shipment, commission } = await createPaidCommission('d');

    // Soft delete is refused (asserted above), so the (shipment, role) slot is
    // still occupied and a replacement cannot be created. This is the whole
    // point of the partial unique staying partial while the payout link does
    // not.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.create({
          data: {
            id: testId('commission-d2'),
            shipmentId: shipment.id,
            crewMemberId,
            role: CrewRole.DRIVER,
            appliedMethod: CommissionMethod.PERCENT_OF_BASE,
            commissionableBase: '12150.0000',
            appliedRate: '0.1500',
            amount: '1822.5000',
          },
        }),
      ),
    ).rejects.toThrow();

    const live = await prisma.commission.findMany({
      where: { shipmentId: shipment.id, role: CrewRole.DRIVER },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(commission.id);
  });

  it('treats PAID as terminal — the run can be neither voided nor deleted', async () => {
    if (!available) return;
    const { run } = await createPaidCommission('e');

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.payoutRun.update({
          where: { id: run.id },
          data: { status: PayoutRunStatus.VOIDED },
        }),
      ),
    ).rejects.toThrow(/terminal/i);

    await expect(
      withActor({ userId: adminId }, async () => prisma.payoutRun.softDelete({ id: run.id })),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('refuses a hard delete of a paid commission or its payout line', async () => {
    if (!available) return;
    const { commission, line } = await createPaidCommission('g');

    // withHardDelete lifts the extension's block, leaving only the database
    // triggers — which must still refuse.
    await expect(
      withHardDelete(async () => prisma.commission.delete({ where: { id: commission.id } })),
    ).rejects.toThrow(/paid payout run and cannot be deleted/i);

    await expect(
      withHardDelete(async () => prisma.payoutLine.delete({ where: { id: line.id } })),
    ).rejects.toThrow(/paid run and cannot be deleted/i);

    const survivor = await prisma.commission.findFirst({ where: { id: commission.id } });
    expect(survivor?.payoutLineId).toBe(line.id);
  });

  it('still counts a paid commission as paid when read with deleted rows included', async () => {
    if (!available) return;
    const { commission, line } = await createPaidCommission('f');

    const seen = await withDeleted(() =>
      prisma.commission.findFirst({ where: { id: commission.id } }),
    );

    expect(seen?.payoutLineId).toBe(line.id);
  });
});
