import {
  createPrismaClient,
  withActor,
  type ExtendedPrismaClient,
  testUuid,
  withTriggersSuspended,
} from '@eztruckr/db';
import { ShipmentStatus, shipmentListQuerySchema, type ShipmentListQuery } from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { ShipmentsService } from './shipments.service';

/**
 * The order the shipment list comes back in.
 *
 * AGAINST A REAL POSTGRES, because every one of these assertions is about SQL
 * this code does not write: ordering through a relation, ordering a nullable
 * column with its blanks last, and a tie-break that has to survive paging. A
 * stubbed Prisma would assert the shape of the argument and prove nothing
 * about the rows that come back — which is the only thing a reader of this
 * screen cares about.
 *
 * The fixtures share one origin and the list is filtered by it, so the seed's
 * own shipments are out of the way without the clients having to be, and the
 * client column can still vary across four names.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let shipments: ShipmentsService;
let adminId: string;

const PREFIX = '0000000b-';
const id = (name: string) => testUuid('0000000b', name);

/** Distinctive enough that nothing the seed creates can match it. */
const LANE = 'ZZ-SORT-FIXTURE';

/**
 * Four trips whose columns deliberately CROSS: no two of the sorts under test
 * produce the same order. A fixture set where date and number happened to
 * agree would pass just as happily with the wrong column in the clause.
 */
const FIXTURES = [
  {
    key: 'a',
    client: 'Delta Logistics',
    number: '20260101001',
    date: '2026-04-04',
    netRate: '30000.0000',
    container: null,
    status: ShipmentStatus.IN_TRANSIT,
  },
  {
    key: 'b',
    client: 'Abad Hauling',
    number: '20260202002',
    date: '2026-02-02',
    netRate: '10000.0000',
    container: 'TCNU3333333',
    status: ShipmentStatus.CLOSED,
  },
  {
    key: 'c',
    client: 'Marquez Trading',
    number: '20260303003',
    date: '2026-01-01',
    // Tied with 'a', so the tie-break has something to break.
    netRate: '30000.0000',
    container: 'BMOU1111111',
    status: ShipmentStatus.DRAFT,
  },
  {
    key: 'd',
    client: 'Zamora Freight',
    number: '20260404004',
    date: '2026-03-03',
    netRate: '20000.0000',
    container: 'MSKU2222222',
    status: ShipmentStatus.PENDING_LIQUIDATION,
  },
] as const;

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    await tx.$executeRawUnsafe(`DELETE FROM "shipment" WHERE "clientId"::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "client" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[shipment-list-sort] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  shipments = new ShipmentsService({ client: prisma } as unknown as PrismaService);

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    for (const fixture of FIXTURES) {
      await prisma.client.create({
        data: { id: id(`client-${fixture.key}`), name: fixture.client },
      });

      await prisma.shipment.create({
        data: {
          id: id(`shipment-${fixture.key}`),
          shipmentNumber: fixture.number,
          status: fixture.status,
          clientId: id(`client-${fixture.key}`),
          shipmentDate: new Date(`${fixture.date}T00:00:00.000Z`),
          origin: LANE,
          destination: 'Batangas',
          containerNumber: fixture.container,
          grossRate: fixture.netRate,
          netRate: fixture.netRate,
        },
      });
    }
  });
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

/** The list as the API would serve it, scoped to the fixtures. */
async function listing(query: Partial<ShipmentListQuery> = {}) {
  const page = await shipments.list(
    shipmentListQuerySchema.parse({ search: LANE, ...query }) as ShipmentListQuery,
  );

  return page.items;
}

const numbers = (rows: { shipmentNumber: string }[]) => rows.map((row) => row.shipmentNumber);

/** A fixture's shipment number, by the key the table above gives it. */
const of = (key: string) => FIXTURES.find((fixture) => fixture.key === key)!.number;

describe.skipIf(!process.env.DATABASE_URL)(
  'the shipment list orders by the column asked for',
  () => {
    it('defaults to the newest trip first, by the date it ran', async () => {
      // No sort given at all — the schema's default is what a fresh screen sends.
      expect(numbers(await listing())).toEqual([of('a'), of('d'), of('b'), of('c')]);
    });

    it('runs the date the other way when asked', async () => {
      expect(numbers(await listing({ sort: 'date', direction: 'asc' }))).toEqual([
        of('c'),
        of('b'),
        of('d'),
        of('a'),
      ]);
    });

    it('orders by shipment number, which is not the order the dates give', async () => {
      expect(numbers(await listing({ sort: 'number', direction: 'asc' }))).toEqual([
        of('a'),
        of('b'),
        of('c'),
        of('d'),
      ]);
    });

    /** Through the relation: the stored column is a uuid, which sorts by nothing. */
    it("orders by the client's name, not by its id", async () => {
      const rows = await listing({ sort: 'client', direction: 'asc' });

      expect(rows.map((row) => row.clientName)).toEqual([
        'Abad Hauling',
        'Delta Logistics',
        'Marquez Trading',
        'Zamora Freight',
      ]);
    });

    it('orders by net rate', async () => {
      const rows = numbers(await listing({ sort: 'netRate', direction: 'asc' }));

      // 'a' and 'c' are tied at 30000, so only the first two are fixed here; the
      // tie itself is the next test's business.
      expect(rows.slice(0, 2)).toEqual([of('b'), of('d')]);
      expect(rows.slice(2).sort()).toEqual([of('a'), of('c')].sort());
    });

    it('orders by status', async () => {
      expect(numbers(await listing({ sort: 'status', direction: 'asc' }))).toEqual([
        of('c'), // Draft
        of('a'), // In transit
        of('d'), // Pending liquidation
        of('b'), // Closed
      ]);
    });

    /**
     * The blanks go last WHICHEVER WAY the sort runs. Postgres puts nulls first
     * on a descending sort by default, which would fill the top of the screen
     * with trips the sort has nothing to say about.
     */
    it('sorts trips with no container number to the bottom in both directions', async () => {
      const ascending = numbers(await listing({ sort: 'container', direction: 'asc' }));
      const descending = numbers(await listing({ sort: 'container', direction: 'desc' }));

      expect(ascending).toEqual([of('c'), of('d'), of('b'), of('a')]);
      expect(descending).toEqual([of('b'), of('d'), of('c'), of('a')]);
    });

    /**
     * Two trips tied on the sorted column must not swap places between one page
     * request and the next — a row that moves across the boundary is served
     * twice or not at all.
     */
    it('breaks a tie the same way every time', async () => {
      // Newest id first is what the service declares; work out which of the
      // tied pair that is rather than assuming it, since the ids are hashed
      // from the fixture names.
      const tied = [
        { number: of('a'), id: id('shipment-a') },
        { number: of('c'), id: id('shipment-c') },
      ].sort((left, right) => (left.id < right.id ? 1 : -1));

      // THE REWRITE IS THE WHOLE TEST. Left alone, four rows come back in the
      // order they were inserted whether or not anything asked them to, so an
      // assertion against a table at rest passes with no tie-break clause at
      // all and pins nothing. Updating the row that must sort FIRST moves it
      // to the end of the heap, so the physical order now contradicts the
      // required one and only an explicit tie-break can still satisfy it —
      // which is what an ordinary edit does to a real table.
      await withTriggersSuspended(prisma, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE "shipment" SET "updatedAt" = "updatedAt" WHERE id = '${tied[0]!.id}'`,
        ),
      );

      const once = numbers(await listing({ sort: 'netRate', direction: 'asc' }));
      const again = numbers(await listing({ sort: 'netRate', direction: 'asc' }));

      expect(again).toEqual(once);
      expect(once.slice(2)).toEqual(tied.map((row) => row.number));
    });
  },
);
