import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  createPrismaClient,
  testUuid,
  withActor,
  withTriggersSuspended,
  type ExtendedPrismaClient,
} from '@eztruckr/db';
import {
  AllowanceRequestStatus,
  CrewRole,
  DisbursementMode,
  ShipmentStatus,
  StaffRole,
  UserRole,
} from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestUser } from '../auth/request-user';
import type { PrismaService } from '../prisma/prisma.service';
import type { StorageService } from '../storage/storage.service';
import { AllowanceRequestsService } from './allowance-requests.service';
import { AllowancesService } from './allowances.service';
import { LiquidationService } from './liquidation.service';
import { ReceiptsService } from './receipts.service';
import { ShipmentsService } from '../shipments/shipments.service';
import { ensurePendingLiquidation } from './pending-liquidation';

/**
 * What the ask-and-approve path has to be true about, against a real database.
 *
 * THE ASSERTIONS THAT MATTER ARE ABOUT ROWS, which is why these are integration
 * tests. "An approval produces an ordinary release counted in the ordinary
 * total advanced" is a claim about what three tables say afterwards; a mocked
 * Prisma would only confirm the mock's opinion of it. The decision CHECK in
 * particular exists precisely because a service can be wrong, so a test that
 * never reaches Postgres cannot see it working.
 *
 * Skips itself, loudly, when no database is reachable — the same behaviour as
 * every other integration suite here.
 */

let prisma: ExtendedPrismaClient;
let available = false;

let requests: AllowanceRequestsService;
let allowances: AllowancesService;
let liquidations: LiquidationService;
/** The close guard lives here, not on the liquidation. */
let shipments: ShipmentsService;

let adminId: string;
/** Accounting, who decides. */
let accountant: RequestUser;
/** Dispatch, who asks. Never the same session as the one that approves. */
let dispatchManager: RequestUser;
let clientId: string;
let driverId: string;
let officeId: string;
let receiptId: string;

/**
 * A prefix of this suite's own, for the same reason `liquidation-lifecycle`
 * has one: Turbo runs the workspaces' suites concurrently against one database
 * and each teardown deletes by prefix, so a shared one wipes another suite's
 * fixtures mid-run.
 */
const PREFIX = '00000004-';
const id = (name: string) => testUuid('00000004', name);

function serviceStubs(client: ExtendedPrismaClient) {
  const prismaService = { client } as unknown as PrismaService;
  // The bucket is never touched here: the receipt fixture is a row, and what is
  // under test is whether one is DEMANDED, not whether MinIO can store it.
  const storage = { remove: async () => undefined } as unknown as StorageService;
  const receipts = new ReceiptsService(prismaService, storage);
  const liquidationService = new LiquidationService(prismaService, receipts);
  const allowancesService = new AllowancesService(prismaService, receipts, liquidationService);

  return {
    liquidations: liquidationService,
    allowances: allowancesService,
    requests: new AllowanceRequestsService(prismaService, allowancesService, liquidationService),
    shipments: new ShipmentsService(prismaService),
  };
}

const CLEANUP_STATEMENTS = [
  // Before allowance, which it references, and before liquidation.
  `DELETE FROM "allowance_request" WHERE "shipmentId"::text LIKE '${PREFIX}%'`,
  `DELETE FROM "settlement" WHERE "shipmentId"::text LIKE '${PREFIX}%'`,
  `DELETE FROM "liquidation_history" WHERE "liquidationId" IN
     (SELECT id FROM "liquidation" WHERE "shipmentId"::text LIKE '${PREFIX}%')`,
  `DELETE FROM "liquidation" WHERE "shipmentId"::text LIKE '${PREFIX}%'`,
  `DELETE FROM "allowance" WHERE "shipmentId"::text LIKE '${PREFIX}%'`,
  `DELETE FROM "receipt" WHERE id::text LIKE '${PREFIX}%'`,
  `DELETE FROM "shipment" WHERE id::text LIKE '${PREFIX}%'`,
  `DELETE FROM "staff" WHERE id::text LIKE '${PREFIX}%'`,
  `DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`,
];

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    for (const statement of CLEANUP_STATEMENTS) {
      await tx.$executeRawUnsafe(statement);
    }
  });
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[allowance-request] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');

  adminId = admin.id;

  // TWO SESSIONS, ONE LOGIN ROW. The point being made is about roles, and the
  // roles are what the guards read; creating a second Better Auth user would
  // test Better Auth. Both still stamp a real `user` id, which every audit
  // column and foreign key here requires.
  accountant = {
    id: adminId,
    email: admin.email,
    name: admin.name,
    role: UserRole.ACCOUNTING,
    isActive: true,
    staffId: null,
  };
  dispatchManager = { ...accountant, role: UserRole.DISPATCH_MANAGER };

  ({ requests, allowances, liquidations, shipments } = serviceStubs(prisma));

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    clientId = (await prisma.client.create({ data: { id: id('client'), name: 'Request Co' } })).id;

    driverId = (
      await prisma.staff.create({
        data: {
          id: id('driver'),
          firstName: 'Request',
          lastName: 'Driver',
          eligibleRoles: [CrewRole.DRIVER],
        },
      })
    ).id;

    // An office cash holder in no slot: the second arm of
    // `mayHoldTripCashWithoutASlot`, and a legitimate recipient of a float.
    officeId = (
      await prisma.staff.create({
        data: {
          id: id('office'),
          firstName: 'Request',
          lastName: 'Manager',
          eligibleRoles: [StaffRole.DISPATCH_MANAGER],
        },
      })
    ).id;

    receiptId = (
      await prisma.receipt.create({
        data: {
          id: id('receipt'),
          fileName: 'transfer.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          storageKey: `${PREFIX}transfer.png`,
        },
      })
    ).id;
  });
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

/** A dispatched trip with one open account and no cash out yet. */
async function trip(suffix: string) {
  const shipmentId = id(`shipment-${suffix}`);
  let liquidationId = '';

  await withActor({ userId: adminId }, async () => {
    await prisma.shipment.create({
      data: {
        id: shipmentId,
        shipmentNumber: id(`SHP-${suffix}`).toUpperCase(),
        status: ShipmentStatus.DISPATCHED,
        clientId,
        driverId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '20000.0000',
        netRate: '20000.0000',
      },
    });

    liquidationId = await ensurePendingLiquidation(prisma, shipmentId);
  });

  return { shipmentId, liquidationId };
}

function ask(shipmentId: string, liquidationId: string, amount: string, staffId = driverId) {
  return withActor({ userId: adminId }, () =>
    requests.create(
      shipmentId,
      { liquidationId, staffId, amount, purpose: 'Trip allowance' },
      dispatchManager,
    ),
  );
}

const cash = {
  disbursementMode: DisbursementMode.CASH,
  referenceNumber: null,
  receiptId: null,
  issuedAt: null,
  releasedBy: null,
  remarks: null,
};

/**
 * Freezes an account the way the application does, rather than by writing the
 * status straight in.
 *
 * A LIQUIDATION AT APPROVED WITH NO `submittedAt` IS REFUSED by
 * `liquidation_submitted_at_matches_status`, which is the database saying that
 * nothing is approved without first having been submitted. Going through the
 * two moves also leaves the settlement the approval is supposed to create, so
 * what the test then acts against is a real frozen account.
 */
async function freezeAccount(liquidationId: string): Promise<void> {
  await withActor({ userId: adminId }, async () => {
    await liquidations.submit(liquidationId, { remarks: null }, accountant);
    await liquidations.approve(liquidationId, { remarks: null }, accountant);
  });
}

describe('an approval is a release', () => {
  /**
   * THE CENTRAL CLAIM. Nothing downstream of a release knows this table exists,
   * so an approved request has to leave exactly the row a direct release would
   * have left — on the same account, in the same total, moving the same
   * variance. If this ever stops holding, the feature has grown a second kind
   * of trip cash, which is the thing it was designed not to be.
   */
  it('writes an ordinary allowance and moves the account it names', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('approved');
    const request = await ask(shipmentId, liquidationId, '10000.00');

    const decided = await withActor({ userId: adminId }, () =>
      requests.approve(request.id, cash, accountant),
    );

    expect(decided.status).toBe(AllowanceRequestStatus.APPROVED);
    expect(decided.allowanceId).not.toBeNull();
    expect(decided.decidedBy).toBe(adminId);

    const summary = await allowances.summary(shipmentId, null);
    expect(summary.releaseCount).toBe(1);
    // The requested figure, carried across untouched and counted in the
    // ordinary total — the same total a direct release would have moved.
    expect(summary.totalAdvanced).toBe('10000.00');
    expect(summary.allowances[0]?.amount).toBe('10000');
    expect(summary.allowances[0]?.id).toBe(decided.allowanceId);
    expect(summary.allowances[0]?.staffId).toBe(driverId);

    // The account's own totals are refreshed by the approval, so the
    // custodian's variance moves by exactly what was handed over. (Stored
    // Decimals serialise through `toString`, hence no trailing zeroes here —
    // the summary above goes through the money helper and keeps two.)
    const account = await liquidations.get(liquidationId);
    expect(account.totalAllowance).toBe('10000');
    // Nothing has been claimed against it, so the whole advance is outstanding.
    expect(account.variance).toBe('10000');
  });

  /**
   * The release inherits WHY it was asked for when the approver says nothing.
   * A blank remark on a row somebody reads in six months is worse than the
   * sentence that explains it.
   */
  it('carries the request’s purpose onto the release', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('purpose');
    const request = await withActor({ userId: adminId }, () =>
      requests.create(
        shipmentId,
        { liquidationId, staffId: driverId, amount: '2000.00', purpose: 'Ferry and toll' },
        dispatchManager,
      ),
    );

    await withActor({ userId: adminId }, () => requests.approve(request.id, cash, accountant));

    const summary = await allowances.summary(shipmentId, null);
    expect(summary.allowances[0]?.remarks).toBe('Ferry and toll');
  });

  /** Cash may be requested for an office float holder, not only for the truck. */
  it('releases to somebody who holds trip cash without a slot', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('office');
    const request = await ask(shipmentId, liquidationId, '3000.00', officeId);

    const decided = await withActor({ userId: adminId }, () =>
      requests.approve(request.id, cash, accountant),
    );

    expect(decided.status).toBe(AllowanceRequestStatus.APPROVED);
  });
});

describe('proof is required exactly where a document already exists', () => {
  it.each([DisbursementMode.BANK_TRANSFER, DisbursementMode.EWALLET])(
    'refuses to approve mode %i with nothing attached',
    async (disbursementMode) => {
      if (!available) return;

      const { shipmentId, liquidationId } = await trip(`proof-${disbursementMode}`);
      const request = await ask(shipmentId, liquidationId, '5000.00');

      await expect(
        withActor({ userId: adminId }, () =>
          requests.approve(request.id, { ...cash, disbursementMode }, accountant),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // AND NOTHING LEAKED. A refusal that had already written the release
      // would be worse than no check at all.
      const summary = await allowances.summary(shipmentId, null);
      expect(summary.releaseCount).toBe(0);
      expect((await requests.get(request.id)).status).toBe(AllowanceRequestStatus.PENDING);
    },
  );

  it('approves a transfer once the confirmation is attached', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('proof-attached');
    const request = await ask(shipmentId, liquidationId, '5000.00');

    const decided = await withActor({ userId: adminId }, () =>
      requests.approve(
        request.id,
        {
          ...cash,
          disbursementMode: DisbursementMode.BANK_TRANSFER,
          referenceNumber: 'BDO-4417',
          receiptId,
        },
        accountant,
      ),
    );

    expect(decided.status).toBe(AllowanceRequestStatus.APPROVED);

    const summary = await allowances.summary(shipmentId, null);
    expect(summary.allowances[0]?.receiptId).toBe(receiptId);
    expect(summary.allowances[0]?.referenceNumber).toBe('BDO-4417');
  });

  /** Cash in the yard produces no document, so none is demanded. */
  it('approves cash with nothing attached', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('proof-cash');
    const request = await ask(shipmentId, liquidationId, '1500.00');

    const decided = await withActor({ userId: adminId }, () =>
      requests.approve(request.id, cash, accountant),
    );

    expect(decided.status).toBe(AllowanceRequestStatus.APPROVED);
  });
});

describe('a decision is final, and a decline says why', () => {
  it('records the reason and releases nothing', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('declined');
    const request = await ask(shipmentId, liquidationId, '99000.00');

    const decided = await withActor({ userId: adminId }, () =>
      requests.decline(request.id, { reason: 'Too much for this lane' }, accountant),
    );

    expect(decided.status).toBe(AllowanceRequestStatus.DECLINED);
    expect(decided.decisionReason).toBe('Too much for this lane');
    expect(decided.allowanceId).toBeNull();
    expect((await allowances.summary(shipmentId, null)).releaseCount).toBe(0);
  });

  it('refuses to approve something already declined, and to decline something approved', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('twice');
    const first = await ask(shipmentId, liquidationId, '1000.00');
    const second = await ask(shipmentId, liquidationId, '2000.00');

    await withActor({ userId: adminId }, () =>
      requests.decline(first.id, { reason: 'Not this trip' }, accountant),
    );
    await expect(
      withActor({ userId: adminId }, () => requests.approve(first.id, cash, accountant)),
    ).rejects.toBeInstanceOf(ConflictException);

    await withActor({ userId: adminId }, () => requests.approve(second.id, cash, accountant));
    await expect(
      withActor({ userId: adminId }, () =>
        requests.decline(second.id, { reason: 'Changed my mind' }, accountant),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    // Exactly one release, from exactly one approval.
    expect((await allowances.summary(shipmentId, null)).releaseCount).toBe(1);
  });

  /**
   * Withdrawing is a soft delete, which is why there is no CANCELLED code:
   * `deletedBy` and `deletedAt` already answer the only question one would.
   */
  it('withdraws a pending ask and refuses to withdraw a decided one', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('withdraw');
    const pending = await ask(shipmentId, liquidationId, '4000.00');
    const approved = await ask(shipmentId, liquidationId, '500.00');

    await withActor({ userId: adminId }, () => requests.withdraw(shipmentId, pending.id));
    expect(await requests.listForShipment(shipmentId)).toHaveLength(1);

    await withActor({ userId: adminId }, () => requests.approve(approved.id, cash, accountant));
    await expect(
      withActor({ userId: adminId }, () => requests.withdraw(shipmentId, approved.id)),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('an ask has to be payable before it is raised', () => {
  it('refuses an account belonging to another trip', async () => {
    if (!available) return;

    const mine = await trip('wrong-account-a');
    const theirs = await trip('wrong-account-b');

    await expect(ask(mine.shipmentId, theirs.liquidationId, '1000.00')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('refuses somebody the trip’s money could not reach', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('stranger');

    // AWAITED INSIDE THE SCOPE, not returned from it: the audit extension
    // fills `createdBy` from AsyncLocalStorage, and a `PrismaPromise` resolved
    // after `withActor` has unwound is written with a null creator — which the
    // `staff_created_by_required` CHECK then refuses.
    const stranger = await withActor({ userId: adminId }, async () =>
      prisma.staff.create({
        data: {
          id: id('stranger'),
          firstName: 'Not',
          lastName: 'OnThisTrip',
          eligibleRoles: [CrewRole.HELPER],
        },
      }),
    );

    await expect(ask(shipmentId, liquidationId, '1000.00', stranger.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  /**
   * An approved account has its total advanced frozen, so there is nothing to
   * release against it — and therefore nothing to ask for either. Refused at
   * the ask so dispatch is told while they are still looking at the form.
   */
  it('refuses an account that has already been approved', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('frozen');

    await freezeAccount(liquidationId);

    await expect(ask(shipmentId, liquidationId, '1000.00')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  /**
   * ASKED AGAIN AT APPROVAL, not only at the ask. Accounts get approved and
   * crew get swapped between the two moments, so the check on the way in is a
   * courtesy and this one is the control.
   */
  it('refuses to approve against an account frozen after the ask', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('frozen-later');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    await freezeAccount(liquidationId);

    await expect(
      withActor({ userId: adminId }, () => requests.approve(request.id, cash, accountant)),
    ).rejects.toBeInstanceOf(ConflictException);

    expect((await requests.get(request.id)).status).toBe(AllowanceRequestStatus.PENDING);
  });
});

describe('the decision shape is the database’s, not the service’s', () => {
  /**
   * WHY THESE ARE RAW SQL. Every other assertion here goes through the service,
   * which is exactly the code that could be wrong — and
   * `allowance_request_decision_matches_status` exists on the argument that an
   * approved request pointing at no release is a state no amount of care in a
   * service reliably prevents. A test that only reached Postgres through the
   * thing under suspicion could not see the constraint working at all.
   *
   * Raw SQL also bypasses the audit extension, so `createdBy` is supplied by
   * hand here; the CHECK on that column is what makes that mandatory.
   */
  it('refuses an approved request that names no release', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('check-approved');

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "allowance_request"
          (id, "shipmentId", "liquidationId", "staffId", amount, purpose, status,
           "requestedBy", "decidedBy", "decidedAt", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('check-approved-row')}', '${shipmentId}', '${liquidationId}',
                '${driverId}', 1000, 'Constraint fixture', ${AllowanceRequestStatus.APPROVED},
                '${adminId}', '${adminId}', now(), now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/decision_matches_status/i);
  });

  it('refuses a decline that gives no reason', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('check-declined');

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "allowance_request"
          (id, "shipmentId", "liquidationId", "staffId", amount, purpose, status,
           "requestedBy", "decidedBy", "decidedAt", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('check-declined-row')}', '${shipmentId}', '${liquidationId}',
                '${driverId}', 1000, 'Constraint fixture', ${AllowanceRequestStatus.DECLINED},
                '${adminId}', '${adminId}', now(), now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/decision_matches_status/i);
  });

  /**
   * A PENDING request carrying a decision is the other half of the same rule,
   * and the more dangerous one: cash released before anybody approved it,
   * sitting in a queue still describing itself as waiting.
   */
  it('refuses a pending request that has already been decided', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('check-pending');

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "allowance_request"
          (id, "shipmentId", "liquidationId", "staffId", amount, purpose, status,
           "requestedBy", "decidedBy", "decidedAt", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('check-pending-row')}', '${shipmentId}', '${liquidationId}',
                '${driverId}', 1000, 'Constraint fixture', ${AllowanceRequestStatus.PENDING},
                '${adminId}', '${adminId}', now(), now(), now(), '${adminId}')
      `),
    ).rejects.toThrow(/decision_matches_status/i);
  });

  /**
   * The companion the three above need. Without it a constraint that refused
   * everything would pass all of them for entirely the wrong reason.
   */
  it('accepts a pending request with nothing decided', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('check-ok');

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "allowance_request"
          (id, "shipmentId", "liquidationId", "staffId", amount, purpose, status,
           "requestedBy", "createdAt", "updatedAt", "createdBy")
        VALUES ('${id('check-ok-row')}', '${shipmentId}', '${liquidationId}',
                '${driverId}', 1000, 'Constraint fixture', ${AllowanceRequestStatus.PENDING},
                '${adminId}', now(), now(), '${adminId}')
      `),
    ).resolves.toBe(1);
  });
});

describe('an undecided ask keeps its trip and its account reachable', () => {
  /**
   * BOTH OF THESE CLOSE A LOOP THAT WOULD OTHERWISE STAY OPEN FOREVER. A
   * pending request whose account or whose trip has gone can never be
   * approved — `assertAccountAccepts` cannot find the account, and a closed
   * shipment refuses every release — so it would sit in accounting's queue with
   * no action that clears it. Declining is a decision and takes one click;
   * withdrawing is dispatch's. Neither is expensive, and neither is what
   * happens by accident.
   */
  it('refuses to remove an account with a request still awaiting a decision', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('remove-account');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    await expect(
      withActor({ userId: adminId }, () => liquidations.remove(liquidationId)),
    ).rejects.toBeInstanceOf(ConflictException);

    // A DECIDED one does not block: it is closed, and refusing on it would make
    // an account that was ever declined impossible to remove at all.
    await withActor({ userId: adminId }, () =>
      requests.decline(request.id, { reason: 'Not needed' }, accountant),
    );

    await expect(
      withActor({ userId: adminId }, () => liquidations.remove(liquidationId)),
    ).resolves.toEqual({ removed: true });
  });

  it('refuses to close a trip with a request still awaiting a decision', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('close');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    // Closing needs computed commissions before it looks at anything else, and
    // this test is about the ask — so the trip is put in the state where the
    // allowance guards are the ones still standing.
    await withActor({ userId: adminId }, async () => {
      await prisma.shipment.update({
        where: { id: shipmentId },
        data: { status: ShipmentStatus.LIQUIDATED, commissionsComputedAt: new Date() },
      });
    });

    await expect(
      withActor({ userId: adminId }, () =>
        shipments.transition(shipmentId, { to: ShipmentStatus.CLOSED, occurredAt: null }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    await withActor({ userId: adminId }, () =>
      requests.decline(request.id, { reason: 'Trip is over' }, accountant),
    );

    const closed = await withActor({ userId: adminId }, () =>
      shipments.transition(shipmentId, { to: ShipmentStatus.CLOSED, occurredAt: null }),
    );

    expect(closed.status).toBe(ShipmentStatus.CLOSED);
  });
});

describe('editing an ask nobody has answered', () => {
  it('corrects every field, and the approval then releases the corrected figure', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('edit');
    const request = await ask(shipmentId, liquidationId, '10000.00');

    const edited = await withActor({ userId: adminId }, () =>
      requests.update(shipmentId, request.id, {
        staffId: officeId,
        amount: '6000.00',
        purpose: 'Reduced after checking the lane',
      }),
    );

    expect(edited.amount).toBe('6000');
    expect(edited.staffId).toBe(officeId);
    expect(edited.purpose).toBe('Reduced after checking the lane');
    expect(edited.status).toBe(AllowanceRequestStatus.PENDING);

    // THE POINT OF THE FEATURE: the release follows the correction, not the
    // original ask. Approval carries no amount of its own, so if the edit had
    // not landed on the row the old figure would have been paid.
    await withActor({ userId: adminId }, () => requests.approve(request.id, cash, accountant));

    const summary = await allowances.summary(shipmentId, null);
    expect(summary.allowances[0]?.amount).toBe('6000');
    expect(summary.allowances[0]?.staffId).toBe(officeId);
    expect(summary.allowances[0]?.remarks).toBe('Reduced after checking the lane');
  });

  it('leaves omitted fields alone', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('edit-partial');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    const edited = await withActor({ userId: adminId }, () =>
      requests.update(shipmentId, request.id, { amount: '1200.00' }),
    );

    expect(edited.amount).toBe('1200');
    expect(edited.staffId).toBe(request.staffId);
    expect(edited.purpose).toBe(request.purpose);
    expect(edited.liquidationId).toBe(request.liquidationId);
  });

  /**
   * The flag exists because approval carries no amount to check against: the
   * approver read a figure, and this is the only thing that says it moved.
   * Derived from `updatedBy`, which the audit extension forces to null on
   * create — a freshly raised ask must therefore report false, and would not
   * have under a comparison of Prisma's clock against Postgres's.
   */
  it('reports itself edited only once it actually has been', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('edit-flag');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    expect(request.editedAfterRaising).toBe(false);
    expect((await requests.get(request.id)).editedAfterRaising).toBe(false);

    await withActor({ userId: adminId }, () =>
      requests.update(shipmentId, request.id, { amount: '1100.00' }),
    );

    expect((await requests.get(request.id)).editedAfterRaising).toBe(true);

    // Deciding is an update too. Reporting every approved request as "edited"
    // would make the marker mean nothing, so it goes quiet once answered.
    await withActor({ userId: adminId }, () => requests.approve(request.id, cash, accountant));
    expect((await requests.get(request.id)).editedAfterRaising).toBe(false);
  });

  it('refuses to edit anything already decided', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('edit-decided');
    const approved = await ask(shipmentId, liquidationId, '100.00');
    const declined = await ask(shipmentId, liquidationId, '200.00');

    await withActor({ userId: adminId }, () => requests.approve(approved.id, cash, accountant));
    await withActor({ userId: adminId }, () =>
      requests.decline(declined.id, { reason: 'No' }, accountant),
    );

    for (const id of [approved.id, declined.id]) {
      await expect(
        withActor({ userId: adminId }, () => requests.update(shipmentId, id, { amount: '5.00' })),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });

  /**
   * RE-VALIDATED, NOT JUST REWRITTEN. The answers can have changed since the ask
   * was raised, so an edit faces the same questions the create did — otherwise
   * it is a way to reach a state the create would have refused.
   */
  it('refuses to move an ask onto an account belonging to another trip', async () => {
    if (!available) return;

    const mine = await trip('edit-wrong-a');
    const theirs = await trip('edit-wrong-b');
    const request = await ask(mine.shipmentId, mine.liquidationId, '1000.00');

    await expect(
      withActor({ userId: adminId }, () =>
        requests.update(mine.shipmentId, request.id, { liquidationId: theirs.liquidationId }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to point an ask at somebody the trip’s money could not reach', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('edit-stranger');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    const stranger = await withActor({ userId: adminId }, async () =>
      prisma.staff.create({
        data: {
          id: id('edit-stranger-staff'),
          firstName: 'Still',
          lastName: 'NotOnThisTrip',
          eligibleRoles: [CrewRole.HELPER],
        },
      }),
    );

    await expect(
      withActor({ userId: adminId }, () =>
        requests.update(shipmentId, request.id, { staffId: stranger.id }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an edit once the account it sits on has been approved', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('edit-frozen');
    const request = await ask(shipmentId, liquidationId, '1000.00');

    await freezeAccount(liquidationId);

    await expect(
      withActor({ userId: adminId }, () =>
        requests.update(shipmentId, request.id, { amount: '900.00' }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses an edit against another trip’s request', async () => {
    if (!available) return;

    const mine = await trip('edit-belongs-a');
    const theirs = await trip('edit-belongs-b');
    const request = await ask(theirs.shipmentId, theirs.liquidationId, '1000.00');

    await expect(
      withActor({ userId: adminId }, () =>
        requests.update(mine.shipmentId, request.id, { amount: '5.00' }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('the queue is what is waiting, across every trip', () => {
  it('lists only pending requests, oldest first', async () => {
    if (!available) return;

    const { shipmentId, liquidationId } = await trip('queue');
    const first = await ask(shipmentId, liquidationId, '100.00');
    const second = await ask(shipmentId, liquidationId, '200.00');

    await withActor({ userId: adminId }, () =>
      requests.decline(first.id, { reason: 'Not needed' }, accountant),
    );

    const pending = await requests.list({ status: AllowanceRequestStatus.PENDING });
    const mine = pending.filter((row) => row.shipmentId === shipmentId);

    expect(mine.map((row) => row.id)).toEqual([second.id]);
    // The cross-trip queue lists trips it never loads, so the number has to
    // come back on the row itself.
    expect(mine[0]?.shipmentNumber).toBeTruthy();
  });
});
