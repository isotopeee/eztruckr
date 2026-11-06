import {
  createPrismaClient,
  testUuid,
  withActor,
  withTriggersSuspended,
  type ExtendedPrismaClient,
} from '@eztruckr/db';
import {
  CrewRole,
  LiquidationStatus,
  NO_LIQUIDATION,
  ShipmentStatus,
  shipmentListQuerySchema,
  type ShipmentListQuery,
} from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * The shipment list's Liquidation filter, against a real Postgres.
 *
 * The filter is a relation filter the database answers, and the column beside
 * it is a summary the service computes — two implementations of one rule (the
 * least advanced account wins). Every case here asserts both, so a filter that
 * drifted from its column fails rather than listing a trip under a heading its
 * own row contradicts.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let shipments: ShipmentsService;
let adminId: string;

const PREFIX = '0000000f-';
const id = (name: string) => testUuid('0000000f', name);

/** Distinctive enough that nothing the seed creates can match it. */
const LANE = 'ZZ-LIQ-FILTER-FIXTURE';

const { PENDING, SUBMITTED, APPROVED } = LiquidationStatus;

/**
 * One trip per answer, and the two that are easy to get wrong: a trip whose
 * accounts disagree ("mixed" — one approved, one submitted, so it is
 * SUBMITTED), and one whose only unapproved account has been removed.
 */
const FIXTURES: readonly {
  key: string;
  accounts: readonly { status: LiquidationStatus; removed?: boolean }[];
}[] = [
  { key: 'none', accounts: [] },
  { key: 'pending', accounts: [{ status: PENDING }] },
  { key: 'mixed', accounts: [{ status: APPROVED }, { status: SUBMITTED }] },
  { key: 'approved', accounts: [{ status: APPROVED }, { status: APPROVED }] },
  { key: 'removed', accounts: [{ status: APPROVED }, { status: PENDING, removed: true }] },
];

const CLEANUP_STATEMENTS = [
  `DELETE FROM "liquidation" WHERE "shipmentId"::text LIKE '${PREFIX}%'`,
  `DELETE FROM "audit_log" WHERE "entityType" = 'Liquidation' AND "entityId" NOT IN
     (SELECT id::text FROM "liquidation")`,
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
    console.warn('[shipment-list-liquidation-filter] database unreachable — skipping');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  shipments = new ShipmentsService({ client: prisma } as unknown as PrismaService);

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    await prisma.client.create({ data: { id: id('client'), name: 'Filter Fixture Client' } });

    // Two custodians, because at most one LIVE account per trip may be
    // unnamed and the two-account trips need both live.
    const custodians = [id('custodian-1'), id('custodian-2')];
    for (const [index, custodianId] of custodians.entries()) {
      await prisma.staff.create({
        data: {
          id: custodianId,
          firstName: 'Filter',
          lastName: `Custodian ${index + 1}`,
          eligibleRoles: [CrewRole.DRIVER],
        },
      });
    }

    for (const [index, fixture] of FIXTURES.entries()) {
      const shipmentId = id(`shipment-${fixture.key}`);

      await prisma.shipment.create({
        data: {
          id: shipmentId,
          shipmentNumber: `2099010${String(index + 1).padStart(4, '0')}`,
          status: ShipmentStatus.DELIVERED,
          clientId: id('client'),
          origin: LANE,
          destination: 'Batangas',
          grossRate: '20000.0000',
          netRate: '20000.0000',
        },
      });

      for (const [sequence, account] of fixture.accounts.entries()) {
        const now = new Date();
        const row = await prisma.liquidation.create({
          data: {
            shipmentId,
            sequence: sequence + 1,
            custodianId: custodians[sequence],
            status: account.status,
            submittedAt: account.status === PENDING ? null : now,
            approvedAt: account.status === APPROVED ? now : null,
            approvedBy: account.status === APPROVED ? adminId : null,
          },
        });

        if (account.removed) {
          await prisma.liquidation.softDelete({ id: row.id });
        }
      }
    }
  });
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

/** The fixture keys the list returns for a filter, plus each row's summary. */
async function filtered(liquidation: ShipmentListQuery['liquidation']) {
  const page = await shipments.list(
    shipmentListQuerySchema.parse({ search: LANE, liquidation }) as ShipmentListQuery,
  );

  const keyOf = new Map(FIXTURES.map((fixture) => [id(`shipment-${fixture.key}`), fixture.key]));

  return page.items
    .map((row) => ({ key: keyOf.get(row.id)!, status: row.liquidationStatus }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe.skipIf(!process.env.DATABASE_URL)('the shipment list filters by liquidation', () => {
  it('finds a trip with an account still with the crew', async () => {
    expect(await filtered(PENDING)).toEqual([{ key: 'pending', status: PENDING }]);
  });

  it('files a trip under its least advanced account', async () => {
    // 'mixed' has an approved account, but its submitted one is what holds it.
    expect(await filtered(SUBMITTED)).toEqual([{ key: 'mixed', status: SUBMITTED }]);
  });

  it('calls a trip approved only when every live account is, ignoring removed ones', async () => {
    expect(await filtered(APPROVED)).toEqual([
      { key: 'approved', status: APPROVED },
      { key: 'removed', status: APPROVED },
    ]);
  });

  it('finds a trip with no account at all', async () => {
    expect(await filtered(NO_LIQUIDATION)).toEqual([{ key: 'none', status: null }]);
  });

  it('accepts the filter as the query string sends it', () => {
    expect(shipmentListQuerySchema.parse({ liquidation: '2' }).liquidation).toBe(SUBMITTED);
    expect(shipmentListQuerySchema.parse({ liquidation: 'none' }).liquidation).toBe(NO_LIQUIDATION);
    expect(() => shipmentListQuerySchema.parse({ liquidation: '9' })).toThrow();
  });
});
