import { createPrismaClient, withActor, type ExtendedPrismaClient } from '@eztruckr/db';
import {
  AdjustmentDirection,
  CrewRole,
  ShipmentStatus,
  signedAdjustmentAmount,
  sumAdjustments,
} from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { AdjustmentsService } from './adjustments.service';
import { CommissionService } from './commission.service';

/**
 * Manual increases and decreases to crew pay.
 *
 * Two things here are load-bearing rather than incidental, and both are the
 * kind that look like details until somebody "tidies" them:
 *
 *   THE ADJUSTMENT SURVIVES A RECOMPUTE. It is attached to the trip and the
 *   person, not to the commission row, because recomputing soft-deletes every
 *   commission on the trip. A `commissionId` link would silently detach.
 *
 *   THE LOCK IS THE ADJUSTMENT'S OWN PAYOUT LINE, not the commission's. A trip
 *   whose commission is already paid can still take an adjustment — that is how
 *   an underpayment gets corrected — while a paid adjustment cannot be edited.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let adjustments: AdjustmentsService;
let commissions: CommissionService;

let adminId: string;
let driverId: string;
let helperId: string;
let strangerId: string;

/** Not `itest-`: see the note in liquidation-lifecycle.test.ts. */
const PREFIX = 'adjtest-';
const id = (name: string) => `${PREFIX}${name}`;

const SHIPMENT_ID = id('shipment');

async function cleanup(): Promise<void> {
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  try {
    for (const table of ['adjustment', 'commission']) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "shipmentId" = '${SHIPMENT_ID}'`,
      );
    }
    await prisma.$executeRawUnsafe(
      `DELETE FROM "adjustment" WHERE "shipmentId" IS NULL AND "staffId" IN ('${driverId ?? ''}', '${helperId ?? ''}')`,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "liquidation" WHERE "shipmentId" = '${SHIPMENT_ID}'`,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM "shipment" WHERE id = '${SHIPMENT_ID}'`);
    await prisma.$executeRawUnsafe(`DELETE FROM "client" WHERE id LIKE '${PREFIX}%'`);
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
    console.warn('[adjustments] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  const driver = await prisma.staff.findFirst({ where: { staffCode: 'CRW-001' } });
  const helper = await prisma.staff.findFirst({ where: { staffCode: 'CRW-003' } });
  const stranger = await prisma.staff.findFirst({ where: { staffCode: 'CRW-004' } });

  if (!admin || !driver || !helper || !stranger) {
    throw new Error('Seed the database first: pnpm db:seed');
  }

  adminId = admin.id;
  driverId = driver.id;
  helperId = helper.id;
  strangerId = stranger.id;

  const service = { client: prisma } as unknown as PrismaService;
  adjustments = new AdjustmentsService(service);
  commissions = new CommissionService(service);
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
      data: { id: id('client'), code: id('CLT').toUpperCase(), name: 'Adjustment Test Client' },
    });

    await prisma.shipment.create({
      data: {
        id: SHIPMENT_ID,
        shipmentNumber: id('SHP').toUpperCase(),
        // Delivered, so commissions may be computed against a settled base.
        status: ShipmentStatus.PENDING_LIQUIDATION,
        clientId: id('client'),
        driverId,
        helperId,
        origin: 'Manila',
        destination: 'Batangas',
        dispatchedAt: new Date('2026-08-11T00:00:00.000Z'),
        grossRate: '50000.0000',
        netRate: '50000.0000',
      },
    });
  });
});

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

/**
 * Asserts the field-level complaint, not the exception's own message.
 *
 * `badRequest` throws `BadRequestException({ message: 'Validation failed',
 * errors: [...] })` so the form can render the message beside the input that
 * caused it — `rejects.toThrow(/…/)` only ever sees "Validation failed", which
 * passes for any rejection at all.
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

/**
 * A payout line to hang a paid figure off. Payout RUNS are not built yet, so
 * this stands in for one — what every guard actually reads is the
 * `payoutLineId` column, never a run's status.
 */
async function payoutLine(suffix: string): Promise<string> {
  const run = await act(async () =>
    prisma.payoutRun.create({
      data: {
        id: id(`run-${suffix}`),
        runNumber: id(`RUN-${suffix}`).toUpperCase(),
        periodStart: new Date('2026-08-01T00:00:00.000Z'),
        periodEnd: new Date('2026-08-31T00:00:00.000Z'),
      },
    }),
  );

  const line = await act(async () =>
    prisma.payoutLine.create({
      data: {
        id: id(`line-${suffix}`),
        payoutRunId: run.id,
        staffId: driverId,
        grossAmount: '0.0000',
        netAmount: '0.0000',
      },
    }),
  );

  return line.id;
}

async function dropPayout(suffix: string): Promise<void> {
  await prisma.$executeRawUnsafe(`SET session_replication_role = replica`);
  await prisma.$executeRawUnsafe(
    `UPDATE "adjustment" SET "payoutLineId" = NULL WHERE "payoutLineId" = '${id(`line-${suffix}`)}'`,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE "commission" SET "payoutLineId" = NULL WHERE "payoutLineId" = '${id(`line-${suffix}`)}'`,
  );
  await prisma.$executeRawUnsafe(`DELETE FROM "payout_line" WHERE id = '${id(`line-${suffix}`)}'`);
  await prisma.$executeRawUnsafe(`DELETE FROM "payout_run" WHERE id = '${id(`run-${suffix}`)}'`);
  await prisma.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
}

const adjust = (overrides: Record<string, unknown> = {}) =>
  act(async () =>
    adjustments.create(
      {
        staffId: driverId,
        shipmentId: SHIPMENT_ID,
        direction: AdjustmentDirection.INCREASE,
        amount: '500.00',
        reason: 'Overnight stay at the port',
        ...overrides,
      } as Parameters<AdjustmentsService['create']>[0],
      adminId,
    ),
  );

describe('the direction carries the sign', () => {
  it('renders an increase positive and a decrease negative', async () => {
    if (!available) return;

    const up = await adjust();
    const down = await adjust({
      direction: AdjustmentDirection.DECREASE,
      amount: '300.00',
      reason: 'Late delivery penalty',
    });

    expect(up.signedAmount).toBe('500.00');
    expect(down.signedAmount).toBe('-300.00');
    // The stored magnitude is positive in both cases. A decrease written as a
    // negative increase would be the same fact spelled two ways, and every sum
    // over the column would be wrong in a way no row reveals.
    expect(up.amount).toBe('500.00');
    expect(down.amount).toBe('300.00');
  });

  it('refuses a negative amount at the database, not just at the schema', async () => {
    if (!available) return;

    await expect(
      act(async () =>
        prisma.adjustment.create({
          data: {
            staffId: driverId,
            shipmentId: SHIPMENT_ID,
            direction: AdjustmentDirection.DECREASE,
            amount: '-300.0000',
            reason: 'Written as a negative decrease',
            approvedBy: adminId,
          },
        }),
      ),
    ).rejects.toThrow(/adjustment_amount_positive/i);
  });

  it('refuses a blank reason, which NOT NULL alone allowed', async () => {
    if (!available) return;

    await expect(
      act(async () =>
        prisma.adjustment.create({
          data: {
            staffId: driverId,
            shipmentId: SHIPMENT_ID,
            direction: AdjustmentDirection.INCREASE,
            amount: '100.0000',
            reason: '   ',
            approvedBy: adminId,
          },
        }),
      ),
    ).rejects.toThrow(/adjustment_reason_not_blank/i);
  });

  it('sums a mixed set the way the shared helper does', async () => {
    if (!available) return;

    const entries = [
      { direction: AdjustmentDirection.INCREASE, amount: '500.00' },
      { direction: AdjustmentDirection.DECREASE, amount: '300.00' },
      { direction: AdjustmentDirection.DECREASE, amount: '50.00' },
    ];

    expect(sumAdjustments(entries)).toBe('150.00');
    expect(signedAdjustmentAmount(entries[1]!)).toBe('-300.00');
  });
});

describe('what an adjustment may be attached to', () => {
  it('refuses a crew member who did not work the trip', async () => {
    if (!available) return;

    await expectFieldError(
      () => adjust({ staffId: strangerId }),
      'staffId',
      /did not work shipment/i,
    );
  });

  it('allows a standing adjustment with no trip at all', async () => {
    if (!available) return;

    const standing = await adjust({
      shipmentId: null,
      staffId: strangerId,
      reason: 'Uniform deduction',
      direction: AdjustmentDirection.DECREASE,
      amount: '250.00',
    });

    expect(standing.shipmentId).toBeNull();
    expect(standing.signedAmount).toBe('-250.00');
  });

  it('records the caller as the approver, not anyone the body names', async () => {
    if (!available) return;

    const created = await adjust();

    expect(created.approvedBy).toBe(adminId);
    expect(created.approvedByName).toBe('System Administrator');
  });
});

describe('the roll-up: commission plus adjustments', () => {
  async function compute() {
    return act(async () => commissions.computeForShipment(SHIPMENT_ID));
  }

  it('adds them up per crew member without touching the commission', async () => {
    if (!available) return;

    const computed = await compute();
    const driverCommission = computed.commissions.find((row) => row.role === CrewRole.DRIVER);

    await adjust({ amount: '500.00' });
    await adjust({
      direction: AdjustmentDirection.DECREASE,
      amount: '200.00',
      reason: 'Damaged pallet',
    });

    const lines = await adjustments.crewPayForShipment(SHIPMENT_ID);
    const driverLine = lines.find((line) => line.staffId === driverId);

    expect(driverLine?.adjustmentsTotal).toBe('300.00');
    // The commission is untouched — that row states its own arithmetic, and an
    // adjustment folded into it would make it lie about itself.
    expect(driverLine?.commission?.amount).toBe(driverCommission?.amount);
    expect(driverLine?.netAmount).toBe((Number(driverCommission?.amount) + 300).toFixed(2));
  });

  it('leaves an unadjusted crew member’s net equal to their commission', async () => {
    if (!available) return;

    await compute();
    await adjust({ amount: '500.00' });

    const lines = await adjustments.crewPayForShipment(SHIPMENT_ID);
    const helperLine = lines.find((line) => line.staffId === helperId);

    expect(helperLine?.adjustments).toHaveLength(0);
    expect(helperLine?.netAmount).toBe(helperLine?.commissionAmount);
  });

  /**
   * THE REASON FOR `shipmentId` RATHER THAN `commissionId`. Recomputing
   * soft-deletes every commission on the trip and writes fresh rows with new
   * ids. An adjustment keyed to a commission would detach here — silently, and
   * in the direction that quietly underpays somebody.
   */
  it('survives a recompute that replaces every commission row', async () => {
    if (!available) return;

    const first = await compute();
    const firstDriverCommissionId = first.commissions.find(
      (row) => row.role === CrewRole.DRIVER,
    )?.id;

    await adjust({ amount: '500.00' });

    // A late charge is exactly what a recompute exists to absorb.
    await act(async () =>
      prisma.additionalCharge.create({
        data: {
          shipmentId: SHIPMENT_ID,
          description: 'Detention discovered late',
          amount: '2000.0000',
          isCommissionable: true,
        },
      }),
    );

    const second = await compute();
    const secondDriverCommissionId = second.commissions.find(
      (row) => row.role === CrewRole.DRIVER,
    )?.id;

    expect(secondDriverCommissionId).not.toBe(firstDriverCommissionId);

    const lines = await adjustments.crewPayForShipment(SHIPMENT_ID);
    const driverLine = lines.find((line) => line.staffId === driverId);

    // Still attached, still counted, and now against the new figure.
    expect(driverLine?.adjustments).toHaveLength(1);
    expect(driverLine?.adjustmentsTotal).toBe('500.00');
    expect(driverLine?.commission?.id).toBe(secondDriverCommissionId);
  });

  /**
   * An adjustment can be agreed on the day, before accounting computes
   * anything. Keying the roll-up on the crew member rather than on a commission
   * join is what stops it disappearing until somebody presses Compute.
   */
  it('reports an adjustment made before commissions were computed', async () => {
    if (!available) return;

    await adjust({ amount: '500.00' });

    const lines = await adjustments.crewPayForShipment(SHIPMENT_ID);
    const driverLine = lines.find((line) => line.staffId === driverId);

    expect(driverLine?.commission).toBeNull();
    expect(driverLine?.commissionAmount).toBe('0.00');
    expect(driverLine?.netAmount).toBe('500.00');
  });
});

describe('the lock is the adjustment’s own payout line', () => {
  it('lets an unpaid adjustment be corrected and withdrawn', async () => {
    if (!available) return;

    const created = await adjust({ amount: '500.00' });

    const corrected = await act(async () =>
      adjustments.update(created.id, { amount: '650.00', reason: 'Corrected: two nights' }),
    );

    expect(corrected.amount).toBe('650.00');
    expect(corrected.reason).toBe('Corrected: two nights');

    await act(async () => adjustments.remove(created.id));

    const remaining = await adjustments.list({ shipmentId: SHIPMENT_ID, unpaidOnly: false });
    expect(remaining).toHaveLength(0);
  });

  it('freezes one that a payout run has taken', async () => {
    if (!available) return;

    const created = await adjust({ amount: '500.00' });

    const lineId = await payoutLine('frozen');
    await prisma.adjustment.update({ where: { id: created.id }, data: { payoutLineId: lineId } });

    await expect(
      act(async () => adjustments.update(created.id, { amount: '9999.00' })),
    ).rejects.toThrow(/already been paid out/i);

    await expect(act(async () => adjustments.remove(created.id))).rejects.toThrow(
      /already been paid out/i,
    );

    const [frozen] = await adjustments.list({ shipmentId: SHIPMENT_ID, unpaidOnly: false });
    expect(frozen?.isEditable).toBe(false);

    await dropPayout('frozen');
  });

  /**
   * NOT the commission's payout line. "We underpaid you on that run, here is
   * the difference on the next one" is the normal way an error gets fixed, and
   * locking on the commission would make it impossible — pushing the
   * correction into a spreadsheet, which is where it stops being auditable.
   */
  it('still accepts an adjustment on a trip whose commission was already paid', async () => {
    if (!available) return;

    await act(async () => commissions.computeForShipment(SHIPMENT_ID));

    const lineId = await payoutLine('paid');
    await prisma.commission.updateMany({
      where: { shipmentId: SHIPMENT_ID, staffId: driverId },
      data: { payoutLineId: lineId },
    });

    const late = await adjust({ amount: '400.00', reason: 'Underpaid — agreed with the driver' });

    expect(late.amount).toBe('400.00');
    expect(late.isEditable).toBe(true);

    await dropPayout('paid');
  });
});
