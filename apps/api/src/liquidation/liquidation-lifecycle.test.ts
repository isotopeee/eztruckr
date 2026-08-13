import { BadRequestException } from '@nestjs/common';
import {
  createPrismaClient,
  withActor,
  withDeleted,
  type ExtendedPrismaClient,
} from '@eztruckr/db';
import {
  CrewRole,
  DisbursementMode,
  LiquidationHistoryAction,
  LiquidationStatus,
  SettlementStatus,
  ShipmentStatus,
  UserRole,
} from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RequestUser } from '../auth/request-user';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { AllowancesService } from './allowances.service';
import { LiquidationService } from './liquidation.service';
import { ReceiptsService } from './receipts.service';
import { SettlementService } from './settlement.service';
import { ensurePendingLiquidation } from './pending-liquidation';

/**
 * The three assertions the Phase 5 brief asks for, against a real database.
 *
 * They are integration tests rather than unit tests because every one of them
 * is about what the ROWS say after a sequence of moves — whether a second
 * approval cycle posts a second set of costs, whether a returned claim is
 * visible in the P&L, whether an approved liquidation can still leave cash
 * outstanding. Mocking Prisma here would test the mock's idea of those, which
 * is exactly the idea under suspicion.
 *
 * Skips itself, loudly, when no database is reachable — the same behaviour as
 * the integration tests in `packages/db`.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let liquidations: LiquidationService;
let allowances: AllowancesService;
let settlements: SettlementService;
let receipts: ReceiptsService;
let shipments: ShipmentsService;
let storage: { removed: string[]; service: StorageService };

let adminId: string;
let actor: RequestUser;
let clientId: string;
let driverId: string;
let helperId: string;
let fuelCategoryId: string;

/**
 * Deliberately NOT the `itest-` prefix used by the integration tests in
 * `packages/db`.
 *
 * Turbo runs the two workspaces' suites at the same time against the same
 * database, and that suite's teardown deletes everything matching `itest-%`.
 * Sharing the prefix means one suite wipes the other's fixtures mid-run, which
 * fails as a confusing foreign-key error several assertions later.
 */
const PREFIX = 'p5test-';
const id = (name: string) => `${PREFIX}${name}`;

/**
 * Storage stubbed to a recorder.
 *
 * The sweep's interesting behaviour is which receipts it decides are orphans,
 * not whether the AWS SDK can delete a key. Recording the keys it asked to
 * remove tests the decision; a real bucket would test MinIO.
 */
function recordingStorage() {
  const removed: string[] = [];

  return {
    removed,
    service: {
      remove: async (key: string) => {
        removed.push(key);
      },
    } as unknown as StorageService,
  };
}

/**
 * The services take `PrismaService` for its `client`. Building them by hand
 * keeps the test to the rules under examination rather than to Nest's
 * container.
 */
function serviceStubs(client: ExtendedPrismaClient, storage: StorageService) {
  const prismaService = { client } as unknown as PrismaService;
  const receipts = new ReceiptsService(prismaService, storage);
  const liquidationService = new LiquidationService(prismaService, receipts);

  return {
    receipts,
    liquidations: liquidationService,
    allowances: new AllowancesService(prismaService, receipts, liquidationService),
    settlements: new SettlementService(prismaService, receipts),
    // The close guard lives here, and it is the one caller that has to know
    // about EVERY account on a trip rather than one of them.
    shipments: new ShipmentsService(prismaService),
  };
}

/**
 * Removes everything these tests created, children first.
 *
 * Most of these rows are matched by their SHIPMENT rather than by their own id,
 * because the services under test generate cuids — only the fixtures created
 * directly carry the prefix. Matching on id alone leaves the allowances and
 * liquidations behind, and since the shipment ids are deterministic, the next
 * run recreates a shipment that the survivors are still pointing at and every
 * total comes out doubled.
 */
const CLEANUP_STATEMENTS = [
  `DELETE FROM "commission" WHERE "shipmentId" LIKE '${PREFIX}%'`,
  `DELETE FROM "liquidation_history" WHERE "liquidationId" IN
     (SELECT id FROM "liquidation" WHERE "shipmentId" LIKE '${PREFIX}%')`,
  `DELETE FROM "liquidation_line" WHERE "liquidationId" IN
     (SELECT id FROM "liquidation" WHERE "shipmentId" LIKE '${PREFIX}%')`,
  // Before crew_deduction, which a carried settlement points at.
  `DELETE FROM "settlement" WHERE "shipmentId" LIKE '${PREFIX}%'`,
  `DELETE FROM "liquidation" WHERE "shipmentId" LIKE '${PREFIX}%'`,
  `DELETE FROM "allowance" WHERE "shipmentId" LIKE '${PREFIX}%'`,
  // After everything that could reference one.
  `DELETE FROM "receipt" WHERE id LIKE '${PREFIX}%'`,
  `DELETE FROM "crew_deduction" WHERE "shipmentId" LIKE '${PREFIX}%'`,
  `DELETE FROM "audit_log" WHERE "entityType" = 'Liquidation' AND "entityId" NOT IN
     (SELECT id FROM "liquidation")`,
  `DELETE FROM "shipment" WHERE id LIKE '${PREFIX}%'`,
  `DELETE FROM "expense_category" WHERE id LIKE '${PREFIX}%'`,
  `DELETE FROM "crew_member" WHERE id LIKE '${PREFIX}%'`,
  `DELETE FROM "client" WHERE id LIKE '${PREFIX}%'`,
];

async function cleanup(): Promise<void> {
  // Triggers off for teardown only. Application code cannot reach a hard
  // delete at all — the soft-delete extension refuses it.
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
    console.warn('[liquidation-lifecycle] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');

  adminId = admin.id;
  actor = {
    id: adminId,
    email: admin.email,
    name: admin.name,
    role: UserRole.ADMINISTRATOR,
    isActive: true,
    crewMemberId: null,
  };

  storage = recordingStorage();
  ({ liquidations, allowances, settlements, receipts, shipments } = serviceStubs(
    prisma,
    storage.service,
  ));

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: id('client'), code: id('CLT').toUpperCase(), name: 'Phase 5 Test Client' },
    });
    clientId = client.id;

    const driver = await prisma.crewMember.create({
      data: {
        id: id('driver'),
        employeeCode: id('CREW').toUpperCase(),
        firstName: 'Test',
        lastName: 'Driver',
        eligibleRoles: [CrewRole.DRIVER],
      },
    });
    driverId = driver.id;

    // A second person on the truck, which is what the whole per-custodian
    // change exists for: two people holding cash on one trip.
    const helper = await prisma.crewMember.create({
      data: {
        id: id('helper'),
        employeeCode: id('CREW2').toUpperCase(),
        firstName: 'Test',
        lastName: 'Helper',
        eligibleRoles: [CrewRole.HELPER],
      },
    });
    helperId = helper.id;

    const category = await prisma.expenseCategory.create({
      data: {
        id: id('fuel'),
        code: id('FUEL').toUpperCase(),
        name: 'Fuel',
        requiresReceipt: false,
      },
    });
    fuelCategoryId = category.id;
  });
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

/**
 * A delivered trip with cash advanced against it, exactly as the application
 * would have produced it: the liquidation is created BY delivery, not by the
 * test, so what is under test includes that wiring.
 *
 * Returns both handles now. A trip can carry an account per cash holder, so
 * "the liquidation for this shipment" stopped identifying one — every action
 * below names the account, and only a few still name the trip.
 */
async function deliveredTrip(suffix: string, advance: string) {
  const shipmentId = id(`shipment-${suffix}`);
  let liquidationId = '';

  await withActor({ userId: adminId }, async () => {
    await prisma.shipment.create({
      data: {
        id: shipmentId,
        shipmentNumber: id(`SHP-${suffix}`).toUpperCase(),
        status: ShipmentStatus.PENDING_LIQUIDATION,
        clientId,
        driverId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '20000.0000',
        netRate: '20000.0000',
      },
    });

    liquidationId = await ensurePendingLiquidation(prisma, shipmentId);

    await allowances.issue(
      shipmentId,
      {
        liquidationId,
        crewMemberId: driverId,
        amount: advance,
        issuedAt: null,
        disbursementMode: DisbursementMode.CASH,
        referenceNumber: null,
        receiptId: null,
        releasedBy: null,
        remarks: null,
      },
      actor,
    );
  });

  return { shipmentId, liquidationId };
}

/**
 * A trip with a driver AND a helper, each holding their own cash.
 *
 * Built the way the application builds it: the account created at booking is
 * named to the driver, a second is opened for the helper, and each release is
 * booked against one of them. The two advances are deliberately different
 * amounts so that a blended figure could not accidentally match either.
 */
async function tripWithTwoAccounts(suffix: string) {
  const shipmentId = id(`shipment-${suffix}`);

  return act(async () => {
    await prisma.shipment.create({
      data: {
        id: shipmentId,
        shipmentNumber: id(`SHP-${suffix}`).toUpperCase(),
        status: ShipmentStatus.PENDING_LIQUIDATION,
        clientId,
        driverId,
        helperId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '20000.0000',
        netRate: '20000.0000',
      },
    });

    const openedAtBooking = await ensurePendingLiquidation(prisma, shipmentId);
    await liquidations.setCustodian(openedAtBooking, { custodianId: driverId });

    const helperAccount = await liquidations.createForShipment(shipmentId, {
      custodianId: helperId,
    });

    for (const [liquidationId, crewMemberId, amount] of [
      [openedAtBooking, driverId, '10000.00'],
      [helperAccount.id, helperId, '3000.00'],
    ] as const) {
      await allowances.issue(
        shipmentId,
        {
          liquidationId,
          crewMemberId,
          amount,
          issuedAt: null,
          disbursementMode: DisbursementMode.CASH,
          referenceNumber: null,
          receiptId: null,
          releasedBy: null,
          remarks: null,
        },
        actor,
      );
    }

    return { shipmentId, driverAccountId: openedAtBooking, helperAccountId: helperAccount.id };
  });
}

/**
 * The sentence inside a field-level validation failure.
 *
 * `badRequest()` puts the complaint in the response body's `errors`, and leaves
 * `error.message` as the generic 'Validation failed' — so a plain
 * `rejects.toThrow(/…/)` matches the wrapper and never what it says.
 */
async function validationMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const body = error instanceof BadRequestException ? error.getResponse() : null;
    const errors = (body as { errors?: { path: string; message: string }[] } | null)?.errors ?? [];

    return errors.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
  }

  throw new Error('expected the call to be refused, and it was not');
}

/** A crew session, which is what the narrowed scoping rules are about. */
function crewActor(crewMemberId: string): RequestUser {
  return {
    id: adminId,
    email: 'crew@eztruckr.ph',
    name: 'Crew',
    role: UserRole.CREW,
    isActive: true,
    crewMemberId,
  };
}

async function addLine(liquidationId: string, amount: string) {
  await withActor({ userId: adminId }, async () =>
    liquidations.addLine(
      liquidationId,
      {
        expenseCategoryId: fuelCategoryId,
        description: 'Diesel',
        amount,
        spentAt: new Date().toISOString(),
        receiptId: null,
      },
      actor,
    ),
  );
}

const act = <T>(fn: () => Promise<T>): Promise<T> => withActor({ userId: adminId }, fn);

describe('a liquidation exists from the moment of delivery', () => {
  it('is created at PENDING, unsubmitted, with the trip total advanced against it', async () => {
    if (!available) return;

    const { liquidationId } = await deliveredTrip('created', '5000.00');
    const liquidation = await liquidations.get(liquidationId);

    expect(liquidation.status).toBe(LiquidationStatus.PENDING);
    // Not a creation timestamp: nobody has submitted anything yet.
    expect(liquidation.submittedAt).toBeNull();
    expect(liquidation.totalAllowance).toBe('5000');
    expect(liquidation.history).toHaveLength(0);
    expect(liquidation.wasReturned).toBe(false);
  });

  it('sums EVERY release, not the largest or the first', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await deliveredTrip('topups', '4000.00');

    // The top-up a driver phones in for from a ferry queue.
    await act(async () =>
      allowances.issue(
        shipmentId,
        {
          liquidationId,
          crewMemberId: driverId,
          amount: '1500.00',
          issuedAt: null,
          disbursementMode: DisbursementMode.EWALLET,
          referenceNumber: 'GC-99213',
          receiptId: null,
          releasedBy: null,
          remarks: 'Ferry queue',
        },
        actor,
      ),
    );

    const summary = await allowances.summary(shipmentId);

    expect(summary.releaseCount).toBe(2);
    expect(summary.totalAdvanced).toBe('5500.00');

    const liquidation = await liquidations.get(liquidationId);
    expect(liquidation.totalAllowance).toBe('5500');
  });
});

describe('return, resubmit, approve', () => {
  let shipmentId: string;
  let liquidationId: string;

  beforeEach(async () => {
    if (!available) return;

    // A fresh trip per case: these are sequences, and a shared one would let an
    // earlier cycle's rows decide a later assertion.
    ({ shipmentId, liquidationId } = await deliveredTrip(
      `cycle-${Math.trunc(performance.now() * 1000)}`,
      '5000.00',
    ));
    await addLine(liquidationId, '3500.00');
  });

  it('a returned liquidation contributes nothing to the P&L', async () => {
    if (!available) return;

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));

    const returned = await act(async () =>
      liquidations.returnToCrew(
        liquidationId,
        { reason: 'The 3,500 fuel line has no receipt' },
        actor,
      ),
    );

    expect(returned.status).toBe(LiquidationStatus.PENDING);
    // The costs are real enough to see and contribute nothing until approved.
    expect(returned.totalLiquidated).toBe('3500');
    expect(returned.recognisedCost).toBe('0.00');

    // "Returned" is PENDING plus history, never a status of its own.
    expect(returned.wasReturned).toBe(true);
    expect(returned.latestReturnReason).toBe('The 3,500 fuel line has no receipt');
    expect(returned.history.map((entry) => entry.action)).toEqual([
      LiquidationHistoryAction.SUBMITTED,
      LiquidationHistoryAction.RETURNED,
    ]);
  });

  it('posts exactly one set of costs across a full return-and-resubmit cycle', async () => {
    if (!available) return;

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () =>
      liquidations.returnToCrew(liquidationId, { reason: 'Missing receipt' }, actor),
    );
    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));

    const approved = await act(async () =>
      liquidations.approve(liquidationId, { remarks: null }, actor),
    );

    expect(approved.status).toBe(LiquidationStatus.APPROVED);

    // The heart of it: one trip, one set of costs, however many times it went
    // round. Recognition is derived from the status rather than posted, so
    // there is nothing a second cycle could post twice.
    //
    // `recognisedCost` is normalised to 2dp and `totalLiquidated` echoes its
    // column, which is why they are spelled differently here: the first is a
    // computed answer that used to change format with its own branch, the
    // second is a Decimal rendered the way every other column is.
    expect(approved.recognisedCost).toBe('3500.00');
    expect(approved.totalLiquidated).toBe('3500');
    expect(approved.lines).toHaveLength(1);

    // And the history kept every step, appended, never overwritten.
    expect(approved.history.map((entry) => entry.action)).toEqual([
      LiquidationHistoryAction.SUBMITTED,
      LiquidationHistoryAction.RETURNED,
      LiquidationHistoryAction.SUBMITTED,
    ]);

    // One live liquidation and one settlement — a second cycle created neither.
    const live = await prisma.liquidation.count({ where: { shipmentId } });
    const settlementRows = await prisma.settlement.count({ where: { shipmentId } });
    expect(live).toBe(1);
    expect(settlementRows).toBe(1);
  });

  it('refuses to approve work the crew never submitted', async () => {
    if (!available) return;

    await expect(
      act(async () => liquidations.approve(liquidationId, { remarks: null }, actor)),
    ).rejects.toThrow(/pending liquidation cannot move to approved/i);
  });
});

describe('an approved liquidation does not mean the cash came back', () => {
  it('still reports the allowance as outstanding, read from the settlement', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await deliveredTrip('outstanding', '5000.00');
    await addLine(liquidationId, '3500.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    const approved = await act(async () =>
      liquidations.approve(liquidationId, { remarks: null }, actor),
    );

    expect(approved.status).toBe(LiquidationStatus.APPROVED);
    expect(approved.variance).toBe('1500');

    // The whole point: the liquidation says the spending is accounted for, and
    // the settlement says the change has not come back. Reading the first to
    // answer the second is the bug this record exists to prevent.
    const settlement = await settlements.getForLiquidation(liquidationId);
    expect(settlement.status).toBe(SettlementStatus.OUTSTANDING);
    expect(settlement.amount).toBe('1500');
    expect(settlement.isOutstanding).toBe(true);

    const report = await settlements.outstanding();
    expect(report.items.map((item) => item.shipmentId)).toContain(shipmentId);
  });

  it('settles a zero variance on the spot, so nothing sits on the alert forever', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await deliveredTrip('exact', '3000.00');
    await addLine(liquidationId, '3000.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));

    const settlement = await settlements.getForLiquidation(liquidationId);

    expect(settlement.amount).toBe('0');
    expect(settlement.status).toBe(SettlementStatus.SETTLED);
    // Nothing moved, so no mode names how it moved.
    expect(settlement.disbursementMode).toBeNull();

    const report = await settlements.outstanding();
    expect(report.items.map((item) => item.shipmentId)).not.toContain(shipmentId);
  });

  it('clears once the movement is recorded', async () => {
    if (!available) return;

    const { liquidationId } = await deliveredTrip('settled', '5000.00');
    await addLine(liquidationId, '4200.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));

    const settled = await act(async () =>
      settlements.record(
        liquidationId,
        {
          disbursementMode: DisbursementMode.CASH,
          referenceNumber: null,
          receiptId: null,
          remarks: null,
        },
        actor,
      ),
    );

    expect(settled.status).toBe(SettlementStatus.SETTLED);
    expect(settled.isOutstanding).toBe(false);
    expect(settled.settledBy).toBe(adminId);
  });

  it('carries a debt to payout as an ordinary crew deduction, and stays outstanding', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await deliveredTrip('carried', '6000.00');
    await addLine(liquidationId, '4000.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));

    const carried = await act(async () =>
      settlements.carryToPayout(liquidationId, { crewMemberId: driverId, reason: null }),
    );

    expect(carried.status).toBe(SettlementStatus.CARRIED_TO_PAYOUT);
    expect(carried.crewDeductionId).not.toBeNull();
    // The decision is made; the money has not moved. It stays on the alert.
    expect(carried.isOutstanding).toBe(true);

    const deduction = await prisma.crewDeduction.findFirst({
      where: { id: carried.crewDeductionId ?? '' },
    });
    expect(deduction?.amount.toString()).toBe('2000');
    expect(deduction?.crewMemberId).toBe(driverId);
    expect(deduction?.shipmentId).toBe(shipmentId);
  });

  it('refuses to carry a balance the company owes the crew', async () => {
    if (!available) return;

    const { liquidationId } = await deliveredTrip('overspent', '1000.00');
    await addLine(liquidationId, '2500.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    const approved = await act(async () =>
      liquidations.approve(liquidationId, { remarks: null }, actor),
    );

    expect(approved.variance).toBe('-1500');

    await expect(
      act(async () =>
        settlements.carryToPayout(liquidationId, { crewMemberId: driverId, reason: null }),
      ),
    ).rejects.toThrow(/money owed to the crew/i);
  });
});

describe('approval is the lock, and reversing it is a reasoned act', () => {
  it('freezes THAT account: no further release against it until it is reversed', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await deliveredTrip('frozen', '3000.00');
    await addLine(liquidationId, '2000.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));

    await expect(
      act(async () =>
        allowances.issue(
          shipmentId,
          {
            liquidationId,
            crewMemberId: driverId,
            amount: '500.00',
            issuedAt: null,
            disbursementMode: DisbursementMode.CASH,
            referenceNumber: null,
            receiptId: null,
            releasedBy: null,
            remarks: null,
          },
          actor,
        ),
      ),
    ).rejects.toThrow(/approved, so its total advanced is frozen/i);

    await expect(
      act(async () =>
        liquidations.addLine(
          liquidationId,
          {
            expenseCategoryId: fuelCategoryId,
            description: 'Late toll',
            amount: '120.00',
            spentAt: new Date().toISOString(),
            receiptId: null,
          },
          actor,
        ),
      ),
    ).rejects.toThrow(/approved and locked/i);
  });

  it('unwinds the settlement, clears the approver, and moves the shipment back', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await deliveredTrip('reversed', '5000.00');
    await addLine(liquidationId, '3500.00');

    // Commissions computed, so approval earns LIQUIDATED — the symmetric
    // predicate both sides share.
    await act(async () =>
      prisma.shipment.update({
        where: { id: shipmentId },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));

    const afterApproval = await prisma.shipment.findFirst({ where: { id: shipmentId } });
    expect(afterApproval?.status).toBe(ShipmentStatus.LIQUIDATED);

    const reversed = await act(async () =>
      liquidations.reverse(liquidationId, { reason: 'Wrong category on the fuel line' }, actor, {
        ipAddress: null,
        userAgent: null,
      }),
    );

    expect(reversed.status).toBe(LiquidationStatus.SUBMITTED);
    // Cleared, so no row claims an approver it no longer has.
    expect(reversed.approvedAt).toBeNull();
    expect(reversed.approvedBy).toBeNull();
    expect(reversed.recognisedCost).toBe('0.00');

    // The settlement went with it: the variance it recorded is no longer final.
    const live = await prisma.settlement.count({ where: { shipmentId } });
    expect(live).toBe(0);

    // And the shipment is honest about no longer having an approved
    // liquidation, rather than sailing through the close guard.
    const afterReversal = await prisma.shipment.findFirst({ where: { id: shipmentId } });
    expect(afterReversal?.status).toBe(ShipmentStatus.PENDING_LIQUIDATION);

    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'Liquidation', entityId: reversed.id },
    });
    expect(audit?.action).toBe('liquidation.reverse-approval');
    expect(audit?.actorId).toBe(adminId);
  });

  it('refuses once the cash movement behind the approval has been recorded', async () => {
    if (!available) return;

    const { liquidationId } = await deliveredTrip('paid-out', '5000.00');
    await addLine(liquidationId, '3500.00');

    await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
    await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));
    await act(async () =>
      settlements.record(
        liquidationId,
        {
          disbursementMode: DisbursementMode.CASH,
          referenceNumber: null,
          receiptId: null,
          remarks: null,
        },
        actor,
      ),
    );

    await expect(
      act(async () =>
        liquidations.reverse(liquidationId, { reason: 'Changed my mind' }, actor, {
          ipAddress: null,
          userAgent: null,
        }),
      ),
    ).rejects.toThrow(/already been settled/i);
  });
});

/**
 * The change these tests exist for: a trip where two people are each holding
 * cash, which the single-liquidation shape could not express at all.
 *
 * Every assertion here would have passed vacuously before — not because the
 * behaviour was right, but because there was only ever one account to ask
 * about, and one `variance` answering for both people at once.
 */
describe('two people holding cash on one trip', () => {
  it('keeps each custodian to their own money, and never blends the two', async () => {
    if (!available) return;

    const { shipmentId, driverAccountId, helperAccountId } =
      await tripWithTwoAccounts('two-custodians');

    await addLine(driverAccountId, '8000.00');
    await addLine(helperAccountId, '3500.00');

    for (const liquidationId of [driverAccountId, helperAccountId]) {
      await act(async () => liquidations.submit(liquidationId, { remarks: null }, actor));
      await act(async () => liquidations.approve(liquidationId, { remarks: null }, actor));
    }

    const driverAccount = await liquidations.get(driverAccountId);
    const helperAccount = await liquidations.get(helperAccountId);

    // Each account is measured against ITS OWN releases. The blended figures
    // would have been 13,000 advanced and 11,500 spent — a single variance of
    // 1,500 that is neither person's, and that says nothing about the helper
    // being 500 out of pocket.
    expect(driverAccount.totalAllowance).toBe('10000');
    expect(driverAccount.totalLiquidated).toBe('8000');
    expect(driverAccount.variance).toBe('2000');

    expect(helperAccount.totalAllowance).toBe('3000');
    expect(helperAccount.totalLiquidated).toBe('3500');
    expect(helperAccount.variance).toBe('-500');

    // And the settlements say who owes whom, which is the fact the old shape
    // was structurally unable to record: the driver returns 2,000 and the
    // company owes the helper 500, on the same trip.
    const settled = await settlements.listForShipment(shipmentId);
    const byCustodian = new Map(settled.map((row) => [row.custodianId, row]));

    expect(settled).toHaveLength(2);
    expect(byCustodian.get(driverId)?.amount).toBe('2000');
    expect(byCustodian.get(helperId)?.amount).toBe('-500');

    // The alert can finally name a person rather than only a trip.
    const report = await settlements.outstanding();
    const mine = report.items.filter((item) => item.shipmentId === shipmentId);

    expect(mine.map((item) => item.custodianName).sort()).toEqual(['Test Driver', 'Test Helper']);
  });

  it('does not call the trip liquidated on one custodian squaring up', async () => {
    if (!available) return;

    const { shipmentId, driverAccountId, helperAccountId } =
      await tripWithTwoAccounts('all-approved');

    await addLine(driverAccountId, '8000.00');
    await addLine(helperAccountId, '2500.00');

    // The other half of the predicate, so approval is the only thing missing.
    await act(async () =>
      prisma.shipment.update({
        where: { id: shipmentId },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    await act(async () => liquidations.submit(driverAccountId, { remarks: null }, actor));
    await act(async () => liquidations.approve(driverAccountId, { remarks: null }, actor));

    // "Somebody squared up" is a far weaker claim than "the trip is accounted
    // for", and the helper is still holding ₱3,000 nobody has counted.
    const midway = await prisma.shipment.findFirst({ where: { id: shipmentId } });
    expect(midway?.status).toBe(ShipmentStatus.PENDING_LIQUIDATION);
    expect(await liquidations.allApproved(shipmentId)).toBe(false);

    await act(async () => liquidations.submit(helperAccountId, { remarks: null }, actor));
    await act(async () => liquidations.approve(helperAccountId, { remarks: null }, actor));

    const afterBoth = await prisma.shipment.findFirst({ where: { id: shipmentId } });
    expect(afterBoth?.status).toBe(ShipmentStatus.LIQUIDATED);
    expect(await liquidations.allApproved(shipmentId)).toBe(true);
  });

  it('lets cash still go to the helper after the driver is approved', async () => {
    if (!available) return;

    const { shipmentId, driverAccountId, helperAccountId } =
      await tripWithTwoAccounts('one-frozen');

    await addLine(driverAccountId, '9000.00');
    await act(async () => liquidations.submit(driverAccountId, { remarks: null }, actor));
    await act(async () => liquidations.approve(driverAccountId, { remarks: null }, actor));

    // The trip-level answer stays permissive while ANY account is open —
    // otherwise approving the driver's would hide the release form from a
    // helper who still needs ferry money.
    const summary = await allowances.summary(shipmentId);
    expect(summary.canIssue).toBe(true);

    const topUp = await act(async () =>
      allowances.issue(
        shipmentId,
        {
          liquidationId: helperAccountId,
          crewMemberId: helperId,
          amount: '600.00',
          issuedAt: null,
          disbursementMode: DisbursementMode.CASH,
          referenceNumber: null,
          receiptId: null,
          releasedBy: null,
          remarks: 'Ferry',
        },
        actor,
      ),
    );

    expect(topUp.liquidationId).toBe(helperAccountId);

    // It moved the helper's total and left the frozen account alone.
    expect((await liquidations.get(helperAccountId)).totalAllowance).toBe('3600');
    expect((await liquidations.get(driverAccountId)).totalAllowance).toBe('10000');
  });

  it('refuses to close the trip while one account is unapproved, and names who', async () => {
    if (!available) return;

    const { shipmentId, driverAccountId, helperAccountId } = await tripWithTwoAccounts('close');

    await addLine(driverAccountId, '10000.00');
    await addLine(helperAccountId, '3000.00');

    await act(async () =>
      prisma.shipment.update({
        where: { id: shipmentId },
        data: { commissionsComputedAt: new Date() },
      }),
    );

    await act(async () => liquidations.submit(driverAccountId, { remarks: null }, actor));
    await act(async () => liquidations.approve(driverAccountId, { remarks: null }, actor));

    // FIRST LINE: the trip cannot reach CLOSED because it has not reached
    // LIQUIDATED — that status is earned by every account being approved, and
    // the driver's paperwork alone does not earn it.
    await expect(
      act(async () =>
        shipments.transition(shipmentId, { to: ShipmentStatus.CLOSED, occurredAt: null }),
      ),
    ).rejects.toThrow(/awaiting liquidation/i);

    // SECOND LINE, and the one worth a test of its own: the close guard itself,
    // reached by forcing the status the first line would have withheld. It is
    // defence in depth — a trip should not be sitting at LIQUIDATED with an
    // unapproved account — and depth that has never been exercised is a guess.
    // It counted approvals and passed on one, which was the same test while a
    // trip could hold a single account; here that would close the trip on the
    // driver's paperwork and strand the helper's ₱3,000.
    await act(async () =>
      prisma.shipment.update({
        where: { id: shipmentId },
        data: { status: ShipmentStatus.LIQUIDATED },
      }),
    );

    await expect(
      act(async () =>
        shipments.transition(shipmentId, { to: ShipmentStatus.CLOSED, occurredAt: null }),
      ),
    ).rejects.toThrow(/unapproved liquidation\(s\) — Test Helper/);

    await act(async () => liquidations.submit(helperAccountId, { remarks: null }, actor));
    await act(async () => liquidations.approve(helperAccountId, { remarks: null }, actor));

    const closed = await act(async () =>
      shipments.transition(shipmentId, { to: ShipmentStatus.CLOSED, occurredAt: null }),
    );

    expect(closed.status).toBe(ShipmentStatus.CLOSED);
  });
});

/**
 * The rules that are the database's, not the service's.
 *
 * Each has a service-level check in front of it that says the same thing in a
 * sentence. These tests go round those checks deliberately: the point of
 * spending a composite key and a partial unique index on them is that they hold
 * when the sentence is bypassed, which is the only version of "enforced" worth
 * the name.
 */
describe('the constraints hold when the service is bypassed', () => {
  it('refuses a release booked against another trip’s account', async () => {
    if (!available) return;

    const mine = await deliveredTrip('fk-mine', '1000.00');
    const theirs = await deliveredTrip('fk-theirs', '1000.00');

    // Written straight through Prisma: the composite FK on
    // (liquidationId, shipmentId) is what makes this impossible, and a plain
    // key on liquidationId alone would have accepted it without complaint.
    await expect(
      act(async () =>
        prisma.allowance.create({
          data: {
            shipmentId: mine.shipmentId,
            liquidationId: theirs.liquidationId,
            crewMemberId: driverId,
            amount: '500.00',
            issuedAt: new Date(),
            disbursementMode: DisbursementMode.CASH,
            releasedBy: adminId,
          },
        }),
      ),
    ).rejects.toThrow(/foreign key|allowance_liquidationId_shipmentId_fkey/i);
  });

  it('refuses a second account with nobody named to it', async () => {
    if (!available) return;

    const { shipmentId } = await deliveredTrip('nulls-not-distinct', '1000.00');

    // NULLS NOT DISTINCT. Two custodian-less accounts on one trip would be
    // indistinguishable from each other, and a release landing on "the
    // unassigned account" would have no way to say which.
    await expect(
      act(async () =>
        prisma.liquidation.create({
          data: { shipmentId, status: LiquidationStatus.PENDING },
        }),
      ),
    ).rejects.toThrow(/unique|liquidation_shipment_custodian_live_key/i);
  });

  it('refuses a second account for somebody who already holds one', async () => {
    if (!available) return;

    const { shipmentId } = await tripWithTwoAccounts('duplicate-custodian');

    // The service says it in a sentence before the index has to. Both exist:
    // a second account for the same person is not a constraint violation to
    // the user, it is a screen that should not have offered it.
    const refusal = await validationMessage(() =>
      act(async () => liquidations.createForShipment(shipmentId, { custodianId: helperId })),
    );

    expect(refusal).toMatch(/custodianId: Test Helper already holds an account/i);
  });

  it('refuses a custodian who never worked the trip', async () => {
    if (!available) return;

    // This trip has a driver and no helper, so the helper is a crew member who
    // exists and was never on it — being answerable for cash you never held is
    // either a typo or a problem.
    const { shipmentId } = await deliveredTrip('outsider-custodian', '1000.00');

    const refusal = await validationMessage(() =>
      act(async () => liquidations.createForShipment(shipmentId, { custodianId: helperId })),
    );

    expect(refusal).toMatch(/custodianId: .*not assigned to shipment/i);
  });
});

/**
 * Crew scoping, narrowed from "did you work this trip" to "is this your cash".
 *
 * The old rule was as tight as a single blended account allowed. Now that each
 * account names a custodian, a helper who worked the trip has no business
 * editing the driver's claims — and the two used to be one row precisely
 * because there was no way to say so.
 */
describe('a crew session reaches only the cash it answers for', () => {
  it('refuses a crew member their colleague’s account', async () => {
    if (!available) return;

    const { driverAccountId } = await tripWithTwoAccounts('crew-scope');

    await expect(
      act(async () =>
        liquidations.addLine(
          driverAccountId,
          {
            expenseCategoryId: fuelCategoryId,
            description: 'Not mine to claim',
            amount: '100.00',
            spentAt: new Date().toISOString(),
            receiptId: null,
          },
          crewActor(helperId),
        ),
      ),
    ).rejects.toThrow(/another crew member/i);
  });

  it('admits the account created at booking, which names nobody yet', async () => {
    if (!available) return;

    // Refusing everybody here would leave the row unusable until an office
    // user got round to naming somebody, which is the state every trip starts
    // in.
    const { liquidationId } = await deliveredTrip('crew-unassigned', '2000.00');

    const line = await act(async () =>
      liquidations.addLine(
        liquidationId,
        {
          expenseCategoryId: fuelCategoryId,
          description: 'Diesel',
          amount: '900.00',
          spentAt: new Date().toISOString(),
          receiptId: null,
        },
        crewActor(driverId),
      ),
    );

    expect(line.liquidationId).toBe(liquidationId);
  });

  it('lists what is waiting on them, not everything on the truck', async () => {
    if (!available) return;

    const { driverAccountId, helperAccountId } = await tripWithTwoAccounts('crew-list');

    const waiting = await liquidations.list({ returnedOnly: false }, helperId);

    // The list is titled "waiting on you". Scoped to the trip rather than the
    // account, it would hand the helper the driver's ₱10,000 to explain, offer
    // a row they could open, and have the write refused — a list that
    // disagrees with the guard behind it.
    expect(waiting.map((row) => row.id)).toContain(helperAccountId);
    expect(waiting.map((row) => row.id)).not.toContain(driverAccountId);
    expect(waiting.every((row) => row.custodianId !== driverId)).toBe(true);
  });
});

describe('orphaned receipts are swept, and only the genuinely orphaned ones', () => {
  /**
   * Receipts are written directly with a chosen `uploadedAt`, because the age
   * is the input under test and waiting a day for it is not an option.
   */
  async function uploadedAt(suffix: string, hoursAgo: number) {
    const receiptId = id(`receipt-${suffix}`);

    await withActor({ userId: adminId }, async () => {
      await prisma.receipt.create({
        data: {
          id: receiptId,
          storageKey: `receipts/${receiptId}.png`,
          fileName: 'fuel.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          uploadedAt: new Date(Date.now() - hoursAgo * 60 * 60 * 1000),
        },
      });
    });

    return receiptId;
  }

  const stillThere = async (receiptId: string) =>
    (await prisma.receipt.count({ where: { id: receiptId } })) === 1;

  it('removes an unattached receipt once the grace period has passed', async () => {
    if (!available) return;

    const receiptId = await uploadedAt('orphan', 48);
    storage.removed.length = 0;

    const result = await act(async () => receipts.sweepOrphans(24));

    expect(result.removed).toBeGreaterThanOrEqual(1);
    expect(await stillThere(receiptId)).toBe(false);
    // The object went too — a swept row that leaves its bytes behind has
    // reclaimed nothing and nothing will ever look at them again.
    expect(storage.removed).toContain(`receipts/${receiptId}.png`);
  });

  it('leaves a fresh upload alone, because attaching is the next request', async () => {
    if (!available) return;

    const receiptId = await uploadedAt('fresh', 1);

    await act(async () => receipts.sweepOrphans(24));

    expect(await stillThere(receiptId)).toBe(true);
  });

  it('leaves an attached receipt alone however old it is', async () => {
    if (!available) return;

    const { liquidationId } = await deliveredTrip('sweep-attached', '2000.00');
    const receiptId = await uploadedAt('attached', 500);

    await act(async () =>
      liquidations.addLine(
        liquidationId,
        {
          expenseCategoryId: fuelCategoryId,
          description: 'Diesel',
          amount: '1000.00',
          spentAt: new Date().toISOString(),
          receiptId,
        },
        actor,
      ),
    );

    const result = await act(async () => receipts.sweepOrphans(1));

    expect(result.stillAttached).toBeGreaterThanOrEqual(1);
    expect(await stillThere(receiptId)).toBe(true);
  });

  /**
   * The case the whole sweep turns on.
   *
   * Every receipt foreign key is ON DELETE SET NULL, and the soft-delete
   * extension hides the deleted line from an ordinary read — so a sweep that
   * asked the default question would call this receipt an orphan and quietly
   * strip the attachment off a row being kept precisely so the history stays
   * readable. `referenceCount` runs inside `withDeleted` for exactly this.
   */
  it('leaves a receipt that only a SOFT-DELETED line still names', async () => {
    if (!available) return;

    const { liquidationId } = await deliveredTrip('sweep-softdeleted', '2000.00');
    const receiptId = await uploadedAt('soft-deleted', 500);

    const line = await act(async () =>
      liquidations.addLine(
        liquidationId,
        {
          expenseCategoryId: fuelCategoryId,
          description: 'Diesel, later corrected',
          amount: '1000.00',
          spentAt: new Date().toISOString(),
          receiptId,
        },
        actor,
      ),
    );

    await act(async () => liquidations.removeLine(liquidationId, line.id, actor));

    // Gone from an ordinary read...
    expect(await prisma.liquidationLine.count({ where: { id: line.id } })).toBe(0);

    await act(async () => receipts.sweepOrphans(1));

    // ...and still holding its receipt.
    expect(await stillThere(receiptId)).toBe(true);

    const preserved = await withDeleted(async () =>
      prisma.liquidationLine.findFirst({ where: { id: line.id }, select: { receiptId: true } }),
    );
    expect(preserved?.receiptId).toBe(receiptId);
  });
});
