import { CommissionMethod, CrewRole, UserRole } from '@eztruckr/types';
import { hashPassword } from 'better-auth/crypto';
import { withActor } from '../src/actor-context';
import { createPrismaClient } from '../src/prisma-client';

/**
 * Development seed. Idempotent — every write is guarded on a natural key, so
 * it is safe to run repeatedly.
 *
 * Two things worth noticing:
 *
 * 1. The administrator is created first and OUTSIDE an actor scope, because
 *    `user.createdBy` is the one audit column that may be null: the bootstrap
 *    admin has no creator. Everything after runs inside `withActor(admin.id)`,
 *    so the audit extension fills `createdBy` on every row with no explicit
 *    assignment anywhere below.
 *
 * 2. Natural keys are only partially unique (WHERE "deletedAt" IS NULL), which
 *    Prisma cannot express, so there is no `upsert` here — the guard is an
 *    explicit findFirst against live rows.
 *
 * Enumerated values come from @eztruckr/types. No numeric literal for a code
 * appears in this file.
 */
const prisma = createPrismaClient();

const ADMIN_EMAIL = 'admin@eztruckr.ph';

/**
 * Development default. Overridden by SEED_ADMIN_PASSWORD, and long enough to
 * satisfy the API's 12-character minimum so a developer who changes one and
 * not the other finds out here rather than at the login screen.
 */
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? 'eztruckr-dev-admin';

/**
 * Gives the bootstrap administrator a password they can actually sign in with.
 *
 * Better Auth stores email/password credentials as an `account` row with
 * providerId `credential` and the hash in `password` — the same row its own
 * sign-up flow writes. Using Better Auth's `hashPassword` rather than reaching
 * for a hashing library directly is what keeps this row verifiable by the
 * running app: the algorithm and encoding are Better Auth's business, and it
 * changes them without asking.
 *
 * Idempotent, and deliberately non-destructive: an existing credential is left
 * alone, so re-running the seed never resets a password someone has changed.
 */
async function seedAdministratorCredential(userId: string) {
  const existing = await prisma.account.findFirst({
    where: { userId, providerId: 'credential' },
  });

  if (existing) return;

  await prisma.account.create({
    data: {
      userId,
      // Better Auth uses the user id as accountId for credential accounts.
      accountId: userId,
      providerId: 'credential',
      password: await hashPassword(ADMIN_PASSWORD),
    },
  });

  console.warn('[seed] administrator credential created');
}

async function seedAdministrator() {
  // No actor scope here on purpose — see the note above.
  const existing = await prisma.user.findFirst({ where: { email: ADMIN_EMAIL } });
  if (existing) return existing;

  return prisma.user.create({
    data: {
      email: ADMIN_EMAIL,
      name: 'System Administrator',
      role: UserRole.ADMINISTRATOR,
      emailVerified: true,
    },
  });
}

/** fuel, toll, food, parking, ferry, gate pass, miscellaneous */
const EXPENSE_CATEGORIES = [
  { code: 'FUEL', name: 'Fuel', requiresReceipt: true, sortOrder: 10 },
  { code: 'TOLL', name: 'Toll', requiresReceipt: true, sortOrder: 20 },
  { code: 'FOOD', name: 'Food', requiresReceipt: false, sortOrder: 30 },
  { code: 'PARKING', name: 'Parking', requiresReceipt: true, sortOrder: 40 },
  { code: 'FERRY', name: 'Ferry', requiresReceipt: true, sortOrder: 50 },
  { code: 'GATE_PASS', name: 'Gate pass', requiresReceipt: true, sortOrder: 60 },
  { code: 'MISC', name: 'Miscellaneous', requiresReceipt: false, sortOrder: 70 },
];

const TRUCKS = [
  {
    plateNumber: 'NAB 1234',
    make: 'Isuzu',
    model: 'Forward',
    modelYear: 2019,
    bodyType: '10-wheeler wing van',
    capacityKg: '12000.00',
  },
  {
    plateNumber: 'TXV 5678',
    make: 'Hino',
    model: 'FM',
    modelYear: 2021,
    bodyType: '10-wheeler closed van',
    capacityKg: '15000.00',
  },
  {
    plateNumber: 'CAS 9012',
    make: 'Fuso',
    model: 'Canter',
    modelYear: 2020,
    bodyType: '6-wheeler dropside',
    capacityKg: '4500.00',
  },
];

const CREW_MEMBERS = [
  {
    employeeCode: 'CRW-001',
    firstName: 'Ricardo',
    lastName: 'Dela Cruz',
    phone: '+63 917 555 0101',
    eligibleRoles: [CrewRole.DRIVER, CrewRole.HELPER],
    licenseNumber: 'N01-23-456789',
    licenseExpiry: new Date('2028-04-30T00:00:00Z'),
  },
  {
    employeeCode: 'CRW-002',
    firstName: 'Ernesto',
    lastName: 'Ramos',
    phone: '+63 918 555 0102',
    eligibleRoles: [CrewRole.DRIVER],
    licenseNumber: 'N02-19-334455',
    licenseExpiry: new Date('2027-11-15T00:00:00Z'),
  },
  {
    employeeCode: 'CRW-003',
    firstName: 'Joel',
    lastName: 'Bautista',
    phone: '+63 919 555 0103',
    // Helper-only: no licence on file, which the schema allows.
    eligibleRoles: [CrewRole.HELPER],
    licenseNumber: null,
    licenseExpiry: null,
  },
  {
    employeeCode: 'CRW-004',
    firstName: 'Michael',
    lastName: 'Santos',
    phone: '+63 920 555 0104',
    eligibleRoles: [CrewRole.HELPER],
    licenseNumber: null,
    licenseExpiry: null,
  },
];

const CLIENTS = [
  {
    code: 'CLT-SMT',
    name: 'San Mateo Trading Corp.',
    contactName: 'Grace Lim',
    phone: '+63 2 8555 0111',
    address: 'Brgy. Bagong Silang, San Mateo, Rizal',
  },
  {
    code: 'CLT-NPL',
    name: 'Northport Logistics Inc.',
    contactName: 'Arnel Reyes',
    phone: '+63 2 8555 0122',
    address: 'Pier 4, North Harbor, Tondo, Manila',
  },
  {
    code: 'CLT-VMD',
    name: 'Visayas Merchandising',
    contactName: 'Dolores Uy',
    phone: '+63 32 555 0133',
    address: 'Mandaue City, Cebu',
  },
];

const THIRD_PARTIES = [
  {
    code: 'TPB-001',
    name: 'Metro Freight Brokerage',
    contactName: 'Ramon Aguilar',
    phone: '+63 917 555 0900',
    defaultCommissionRate: '0.1000',
  },
];

const ROUTES = [
  {
    code: 'RTE-MNL-BTG',
    name: 'Manila to Batangas Port',
    origin: 'Manila',
    destination: 'Batangas Port',
    distanceKm: '112.00',
    standardRate: '18000.0000',
  },
  {
    code: 'RTE-MNL-CLK',
    name: 'Manila to Clark',
    origin: 'Manila',
    destination: 'Clark, Pampanga',
    distanceKm: '95.00',
    standardRate: '15000.0000',
  },
  {
    code: 'RTE-MNL-NAG',
    name: 'Manila to Naga',
    origin: 'Manila',
    destination: 'Naga City',
    distanceKm: '377.00',
    standardRate: '42000.0000',
  },
  {
    code: 'RTE-MNL-SFD',
    name: 'Manila to San Fernando',
    origin: 'Manila',
    destination: 'San Fernando, La Union',
    distanceKm: '270.00',
    standardRate: '33000.0000',
  },
];

/**
 * Baseline company-wide rates. Unscoped and lowest priority, so any narrower
 * rule added later wins.
 */
const COMMISSION_RULES = [
  {
    name: 'Default driver commission',
    role: CrewRole.DRIVER,
    method: CommissionMethod.PERCENT_OF_BASE,
    rate: '0.1500',
  },
  {
    name: 'Default helper commission',
    role: CrewRole.HELPER,
    method: CommissionMethod.PERCENT_OF_BASE,
    rate: '0.0750',
  },
];

async function seedMasterData() {
  for (const category of EXPENSE_CATEGORIES) {
    const existing = await prisma.expenseCategory.findFirst({ where: { code: category.code } });
    if (!existing) await prisma.expenseCategory.create({ data: category });
  }

  for (const truck of TRUCKS) {
    const existing = await prisma.truck.findFirst({ where: { plateNumber: truck.plateNumber } });
    if (!existing) await prisma.truck.create({ data: truck });
  }

  for (const crew of CREW_MEMBERS) {
    const existing = await prisma.crewMember.findFirst({
      where: { employeeCode: crew.employeeCode },
    });
    if (!existing) await prisma.crewMember.create({ data: crew });
  }

  for (const client of CLIENTS) {
    const existing = await prisma.client.findFirst({ where: { code: client.code } });
    if (!existing) await prisma.client.create({ data: client });
  }

  for (const thirdParty of THIRD_PARTIES) {
    const existing = await prisma.thirdParty.findFirst({ where: { code: thirdParty.code } });
    if (!existing) await prisma.thirdParty.create({ data: thirdParty });
  }

  for (const route of ROUTES) {
    const existing = await prisma.route.findFirst({ where: { code: route.code } });
    if (!existing) await prisma.route.create({ data: route });
  }

  for (const rule of COMMISSION_RULES) {
    const existing = await prisma.commissionRule.findFirst({
      where: { role: rule.role, clientId: null, routeId: null, priority: 0 },
    });
    if (!existing) {
      await prisma.commissionRule.create({
        data: { ...rule, priority: 0, effectiveFrom: new Date('2020-01-01T00:00:00Z') },
      });
    }
  }
}

async function seedSystemSetting() {
  const existing = await prisma.systemSetting.findFirst({ where: { id: 'singleton' } });
  if (existing) return existing;

  // Rates come from the schema defaults (25% gas, 15% driver, 7.5% helper) so
  // they are declared in exactly one place.
  return prisma.systemSetting.create({ data: { id: 'singleton' } });
}

async function main() {
  const admin = await seedAdministrator();
  await seedAdministratorCredential(admin.id);

  // Everything below is attributed to the administrator automatically.
  await withActor({ userId: admin.id }, async () => {
    const profile = await prisma.userProfile.findFirst({ where: { userId: admin.id } });
    if (!profile) {
      await prisma.userProfile.create({
        data: { userId: admin.id, displayName: 'System Administrator' },
      });
    }

    const setting = await seedSystemSetting();
    await seedMasterData();

    const counts = {
      users: await prisma.user.count(),
      trucks: await prisma.truck.count(),
      crewMembers: await prisma.crewMember.count(),
      clients: await prisma.client.count(),
      thirdParties: await prisma.thirdParty.count(),
      routes: await prisma.route.count(),
      expenseCategories: await prisma.expenseCategory.count(),
      commissionRules: await prisma.commissionRule.count(),
    };

    console.warn('[seed] complete');
    console.warn(
      '[seed] admin:',
      admin.email,
      `(createdBy=${String(admin.createdBy)} — bootstrap)`,
    );
    console.warn('[seed] gasExpenseDeductionRate:', setting.gasExpenseDeductionRate.toString());
    console.warn('[seed] counts:', counts);
  });
}

main()
  .catch((error) => {
    console.error('[seed] failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
