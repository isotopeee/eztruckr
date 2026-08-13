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
 * The crew member who gets a portal login, by employee code.
 *
 * ONE OF THEM, not all four, and that is the point of the fixture: the crew
 * portal's whole job is showing a signed-in person their own records and
 * nobody else's, and a seed where every crew member can log in cannot
 * demonstrate the difference. Joel Bautista is helper-only with no licence on
 * file, so he also exercises the case where the crew scoping has to hold for
 * someone who can never be the driver.
 */
const CREW_LOGIN_EMPLOYEE_CODE = 'CRW-003';
const CREW_LOGIN_EMAIL = 'joel.bautista@eztruckr.ph';
const CREW_PASSWORD = process.env.SEED_CREW_PASSWORD ?? 'eztruckr-dev-crew';

/**
 * Gives a seeded user a password they can actually sign in with.
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
async function seedCredential(userId: string, password: string, label: string) {
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
      password: await hashPassword(password),
    },
  });

  console.warn(`[seed] ${label} credential created`);
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
 *
 * These are load-bearing, not decorative. Now that the SystemSetting fallback
 * is gone, CommissionRule is the only source of truth for crew pay and a
 * shipment matching no rule is an error rather than a silent default. These two
 * rows are what make the unscoped case resolve, so removing them without a
 * replacement stops commissions computing — which is the intended behaviour,
 * but should be a decision rather than a surprise.
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

/**
 * A working crew login, linked to the crew member it speaks for.
 *
 * `crewMemberId` is the whole account. Every crew-facing query filters on it,
 * and the API refuses outright — rather than returning an unfiltered list —
 * when a CREW user has none, so a crew login without the link is a broken
 * account rather than a permissive one. That is why this runs after the crew
 * members exist and reads the id back rather than assuming one.
 *
 * Created directly through Prisma rather than through the API's `signUpEmail`
 * path, because that path deliberately cannot set `role` or `crewMemberId` —
 * they are `input: false` in the Better Auth config, which is what stops a
 * request body choosing its own privileges. The seed is not a request.
 */
async function seedCrewLogin() {
  const crewMember = await prisma.crewMember.findFirst({
    where: { employeeCode: CREW_LOGIN_EMPLOYEE_CODE },
  });

  if (!crewMember) {
    throw new Error(`Crew member ${CREW_LOGIN_EMPLOYEE_CODE} is missing; cannot seed its login`);
  }

  const name = `${crewMember.firstName} ${crewMember.lastName}`;

  // Keyed on `crewMemberId`, not on the email. That column is what the partial
  // unique index constrains and what every crew-facing query filters on, so it
  // is the honest answer to "does this crew member already have a login" — an
  // email lookup would miss one created under a different address and then
  // fail on the index instead of finding it. A login provisioned by hand in
  // development is exactly that case.
  const existing = await prisma.user.findFirst({ where: { crewMemberId: crewMember.id } });

  const user =
    existing ??
    (await prisma.user.create({
      data: {
        email: CREW_LOGIN_EMAIL,
        name,
        role: UserRole.CREW,
        crewMemberId: crewMember.id,
        emailVerified: true,
      },
    }));

  // The one thing an adopted login is allowed to have corrected. A display
  // name that disagrees with the crew member the account is LINKED to is not a
  // cosmetic difference: the link decides which trips the session can see, so
  // a login labelled with someone else's name shows one person's records under
  // another person's heading. The email and the password are left alone —
  // those are credentials somebody may be signing in with.
  if (user.name !== name) {
    console.warn(`[seed] crew login ${user.email} was named "${user.name}"; corrected to ${name}`);
    await prisma.user.update({ where: { id: user.id }, data: { name } });
  }

  await seedCredential(user.id, CREW_PASSWORD, `crew (${user.email})`);

  const profile = await prisma.userProfile.findFirst({ where: { userId: user.id } });
  if (!profile) {
    await prisma.userProfile.create({
      data: { userId: user.id, displayName: name, phone: crewMember.phone },
    });
  }

  return { ...user, name };
}

async function seedSystemSetting() {
  const existing = await prisma.systemSetting.findFirst({ where: { id: 'singleton' } });
  if (existing) return existing;

  // The gas deduction rate comes from the schema default (25%) so it is
  // declared in exactly one place. Commission rates are NOT here — the
  // unscoped CommissionRule rows below are the only source of truth for them.
  return prisma.systemSetting.create({ data: { id: 'singleton' } });
}

async function main() {
  const admin = await seedAdministrator();
  await seedCredential(admin.id, ADMIN_PASSWORD, 'administrator');

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
    // After the crew members exist — the login is nothing without its link.
    const crew = await seedCrewLogin();

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
    console.warn('[seed] crew:', crew.email, `(crewMemberId=${String(crew.crewMemberId)})`);
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
