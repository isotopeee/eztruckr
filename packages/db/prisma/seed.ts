import { CommissionMethod, CrewRole, PayeeType, StaffRole, UserRole } from '@eztruckr/types';
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
 * The staff who get a login, matched by name.
 *
 * ONE CREW MEMBER, not all four, and that is the point of the fixture: the crew
 * portal's whole job is showing a signed-in person their own records and
 * nobody else's, and a seed where every crew member can log in cannot
 * demonstrate the difference. Joel Bautista is helper-only with no licence on
 * file, so he also exercises the case where the crew scoping has to hold for
 * someone who can never be the driver.
 *
 * The dispatch manager is the OTHER kind of linked login, and the pair is what
 * makes the difference visible: both name a staff row, and only the crew one is
 * scoped by it. Marites Reyes sees every trip and can dispatch, and still
 * cannot approve the float she is holding.
 */
const STAFF_LOGINS = [
  {
    firstName: 'Joel',
    lastName: 'Bautista',
    email: 'joel.bautista@eztruckr.ph',
    password: process.env.SEED_CREW_PASSWORD ?? 'eztruckr-dev-crew',
    role: UserRole.CREW,
    label: 'crew',
  },
  {
    firstName: 'Marites',
    lastName: 'Reyes',
    email: 'marites.reyes@eztruckr.ph',
    password: process.env.SEED_DISPATCH_PASSWORD ?? 'eztruckr-dev-dispatch',
    role: UserRole.DISPATCH_MANAGER,
    label: 'dispatch manager',
  },
];

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

/** fuel, toll, food, parking, ferry, gate pass, miscellaneous, and the overhead four */
/**
 * `requiresPayee` is a STARTING POSITION, not a rule the code depends on — the
 * office moves it per category on the Expense categories screen.
 *
 * Split the way the argument for the toggle ran: a filling station, a ferry
 * operator and a port each issue something with a name on it, while a toll
 * booth, a roadside carinderia and a parking attendant do not, and demanding a
 * master record for those gets answered with an invented one. Miscellaneous is
 * off because a category that means "something else" cannot promise a vendor.
 *
 * The column defaults to true, so an omission here would be the strict setting
 * rather than the lax one. They are stated anyway: which side a category falls
 * on is the point of the feature, and inferring it from silence is how it ends
 * up wrong.
 *
 * `offeredOnTrips` / `offeredOnOverhead` say WHERE each one appears, and every
 * entry states both for the same reason. The column defaults are asymmetric —
 * trips true, overhead false — so silence would have made the whole list
 * trip-only and left the operation-expense picker EMPTY on a fresh install,
 * which is a feature that looks broken rather than one that looks new.
 *
 * FUEL IS THE INTERESTING ROW: offered on both, because a fleet card fills a
 * truck on a job and the office pickup between them, and "what did we spend on
 * fuel this year" should be one category rather than two that somebody keeps in
 * step by hand. That case is the entire reason overhead did not get a category
 * table of its own.
 */
const EXPENSE_CATEGORIES = [
  // Both: a fleet card fills a truck on a job and the office pickup between
  // them. The row that makes one shared category table the right answer.
  {
    name: 'Fuel',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: true,
    offeredOnOverhead: true,
    sortOrder: 10,
  },
  {
    name: 'Toll',
    requiresReceipt: true,
    requiresPayee: false,
    offeredOnTrips: true,
    offeredOnOverhead: false,
    sortOrder: 20,
  },
  {
    name: 'Food',
    requiresReceipt: false,
    requiresPayee: false,
    offeredOnTrips: true,
    offeredOnOverhead: false,
    sortOrder: 30,
  },
  {
    name: 'Parking',
    requiresReceipt: true,
    requiresPayee: false,
    offeredOnTrips: true,
    offeredOnOverhead: false,
    sortOrder: 40,
  },
  {
    name: 'Ferry',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: true,
    offeredOnOverhead: false,
    sortOrder: 50,
  },
  {
    name: 'Gate pass',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: true,
    offeredOnOverhead: false,
    sortOrder: 60,
  },
  {
    name: 'Miscellaneous',
    requiresReceipt: false,
    requiresPayee: false,
    offeredOnTrips: true,
    offeredOnOverhead: false,
    sortOrder: 70,
  },

  // The overhead side. Spaced from 100 so the two groups stay visually apart on
  // the categories screen and a new trip category still has room at 80 or 90.
  //
  // Repairs is the second both-sides row: a workshop invoice for a truck on a
  // job is that trip's cost, and one for a truck sitting idle is the company's.
  {
    name: 'Repairs and maintenance',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: true,
    offeredOnOverhead: true,
    sortOrder: 100,
  },
  {
    name: 'Office rent',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: false,
    offeredOnOverhead: true,
    sortOrder: 110,
  },
  {
    name: 'Utilities',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: false,
    offeredOnOverhead: true,
    sortOrder: 120,
  },
  // Registration, insurance and permits: an LTO renewal and a comprehensive
  // policy are the same kind of annual, per-unit obligation and the office
  // files them together.
  {
    name: 'Registration and insurance',
    requiresReceipt: true,
    requiresPayee: true,
    offeredOnTrips: false,
    offeredOnOverhead: true,
    sortOrder: 130,
  },
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

const STAFF = [
  {
    firstName: 'Ricardo',
    lastName: 'Dela Cruz',
    phone: '+63 917 555 0101',
    email: 'ricardo.delacruz@eztruckr.ph',
    eligibleRoles: [CrewRole.DRIVER, CrewRole.HELPER],
    licenseNumber: 'N01-23-456789',
    licenseExpiry: new Date('2028-04-30T00:00:00Z'),
  },
  {
    firstName: 'Ernesto',
    lastName: 'Ramos',
    phone: '+63 918 555 0102',
    email: 'ernesto.ramos@eztruckr.ph',
    eligibleRoles: [CrewRole.DRIVER],
    licenseNumber: 'N02-19-334455',
    licenseExpiry: new Date('2027-11-15T00:00:00Z'),
  },
  {
    firstName: 'Joel',
    lastName: 'Bautista',
    phone: '+63 919 555 0103',
    // Matches this person's login address, because it is the same person — but
    // the two columns stay independent: `seedStaffLogin` reads STAFF_LOGINS,
    // never this field, so correcting one here cannot move an account.
    email: 'joel.bautista@eztruckr.ph',
    // Helper-only: no licence on file, which the schema allows.
    eligibleRoles: [CrewRole.HELPER],
    licenseNumber: null,
    licenseExpiry: null,
  },
  {
    firstName: 'Michael',
    lastName: 'Santos',
    phone: '+63 920 555 0104',
    // Deliberately no email: the column is optional, and dev data that filled
    // every row would never exercise the empty case the screens have to render.
    email: null,
    eligibleRoles: [CrewRole.HELPER],
    licenseNumber: null,
    licenseExpiry: null,
  },
  {
    // Office, not crew: never in a shipment slot, never on a commission, and
    // deliberately without a licence. She is here so a trip's float can be
    // handed to somebody who is answerable for it without driving it.
    firstName: 'Marites',
    lastName: 'Reyes',
    phone: '+63 921 555 0105',
    email: 'marites.reyes@eztruckr.ph',
    eligibleRoles: [StaffRole.DISPATCH_MANAGER],
    licenseNumber: null,
    licenseExpiry: null,
  },
];

const CLIENTS = [
  {
    name: 'San Mateo Trading Corp.',
    contactName: 'Grace Lim',
    phone: '+63 2 8555 0111',
    address: 'Brgy. Bagong Silang, San Mateo, Rizal',
  },
  {
    name: 'Northport Logistics Inc.',
    contactName: 'Arnel Reyes',
    phone: '+63 2 8555 0122',
    address: 'Pier 4, North Harbor, Tondo, Manila',
  },
  {
    name: 'Visayas Merchandising',
    contactName: 'Dolores Uy',
    phone: '+63 32 555 0133',
    address: 'Mandaue City, Cebu',
  },
];

const THIRD_PARTIES = [
  {
    name: 'Metro Freight Brokerage',
    contactName: 'Ramon Aguilar',
    phone: '+63 917 555 0900',
    defaultCommissionRate: '0.1000',
  },
];

/**
 * A company and an individual, so both `PayeeType` codes are exercised the
 * first time anybody opens the screen — and so the distinction that justifies
 * the column is visible rather than asserted.
 */
const PAYEES = [
  {
    payeeType: PayeeType.COMPANY,
    name: 'Petron Calamba',
    contactName: 'Station manager',
    phone: '+63 49 545 1180',
    address: 'National Highway, Calamba, Laguna',
    tin: '000-123-456-000',
  },
  {
    payeeType: PayeeType.COMPANY,
    name: 'Starlite Ferries',
    contactName: 'Terminal booking office',
    address: 'Batangas Port, Batangas City',
    tin: '004-567-890-000',
  },
  {
    payeeType: PayeeType.INDIVIDUAL,
    name: 'Rodel Santos',
    phone: '+63 918 555 0142',
    address: 'Brgy. Halang, Calamba, Laguna',
  },
];

const ROUTES = [
  {
    name: 'Manila to Batangas Port',
    origin: 'Manila',
    destination: 'Batangas Port',
    distanceKm: '112.00',
    standardRate: '18000.0000',
  },
  {
    name: 'Manila to Clark',
    origin: 'Manila',
    destination: 'Clark, Pampanga',
    distanceKm: '95.00',
    standardRate: '15000.0000',
  },
  {
    name: 'Manila to Naga',
    origin: 'Manila',
    destination: 'Naga City',
    distanceKm: '377.00',
    standardRate: '42000.0000',
  },
  {
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
    const existing = await prisma.expenseCategory.findFirst({ where: { name: category.name } });
    if (!existing) await prisma.expenseCategory.create({ data: category });
  }

  for (const truck of TRUCKS) {
    const existing = await prisma.truck.findFirst({ where: { plateNumber: truck.plateNumber } });
    if (!existing) await prisma.truck.create({ data: truck });
  }

  for (const crew of STAFF) {
    // Keyed on the name, since `staffCode` was dropped and staff carry no
    // natural key at all now. The database will NOT refuse a duplicate here —
    // two employees may legitimately share a name — so this guard is the only
    // thing keeping a second seed run from inserting everybody twice.
    const existing = await prisma.staff.findFirst({
      where: { firstName: crew.firstName, lastName: crew.lastName },
    });
    if (!existing) await prisma.staff.create({ data: crew });
  }

  for (const client of CLIENTS) {
    const existing = await prisma.client.findFirst({ where: { name: client.name } });
    if (!existing) await prisma.client.create({ data: client });
  }

  for (const thirdParty of THIRD_PARTIES) {
    const existing = await prisma.thirdParty.findFirst({ where: { name: thirdParty.name } });
    if (!existing) await prisma.thirdParty.create({ data: thirdParty });
  }

  for (const payee of PAYEES) {
    const existing = await prisma.payee.findFirst({ where: { name: payee.name } });
    if (!existing) await prisma.payee.create({ data: payee });
  }

  for (const route of ROUTES) {
    const existing = await prisma.route.findFirst({ where: { name: route.name } });
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
 * A working login, linked to the staff member it speaks for.
 *
 * `staffId` is the whole account for a CREW login: every crew-facing query
 * filters on it, and the API refuses outright — rather than returning an
 * unfiltered list — when a CREW user has none, so a crew login without the link
 * is a broken account rather than a permissive one. A DISPATCH_MANAGER carries
 * the same link for the opposite reason: nothing scopes them by it, and it is
 * there so their own floats can be told apart from everyone else's. Either way
 * this runs after the staff exist and reads the id back rather than assuming
 * one.
 *
 * Created directly through Prisma rather than through the API's `signUpEmail`
 * path, because that path deliberately cannot set `role` or `staffId` —
 * they are `input: false` in the Better Auth config, which is what stops a
 * request body choosing its own privileges. The seed is not a request.
 */
async function seedStaffLogin(spec: (typeof STAFF_LOGINS)[number]) {
  const staffMember = await prisma.staff.findFirst({
    where: { firstName: spec.firstName, lastName: spec.lastName },
  });

  if (!staffMember) {
    throw new Error(
      `Staff member ${spec.firstName} ${spec.lastName} is missing; cannot seed its login`,
    );
  }

  const name = `${staffMember.firstName} ${staffMember.lastName}`;

  // Keyed on `staffId`, not on the email. That column is what the partial
  // unique index constrains and what every crew-facing query filters on, so it
  // is the honest answer to "does this person already have a login" — an email
  // lookup would miss one created under a different address and then fail on
  // the index instead of finding it. A login provisioned by hand in
  // development is exactly that case.
  const existing = await prisma.user.findFirst({ where: { staffId: staffMember.id } });

  const user =
    existing ??
    (await prisma.user.create({
      data: {
        email: spec.email,
        name,
        role: spec.role,
        staffId: staffMember.id,
        emailVerified: true,
      },
    }));

  // The one thing an adopted login is allowed to have corrected. A display
  // name that disagrees with the staff member the account is LINKED to is not a
  // cosmetic difference: for a crew login the link decides which trips the
  // session can see, so a login labelled with someone else's name shows one
  // person's records under another person's heading. The email and the password
  // are left alone — those are credentials somebody may be signing in with.
  if (user.name !== name) {
    console.warn(
      `[seed] ${spec.label} login ${user.email} was named "${user.name}"; corrected to ${name}`,
    );
    await prisma.user.update({ where: { id: user.id }, data: { name } });
  }

  await seedCredential(user.id, spec.password, `${spec.label} (${user.email})`);

  const profile = await prisma.userProfile.findFirst({ where: { userId: user.id } });
  if (!profile) {
    await prisma.userProfile.create({
      data: { userId: user.id, displayName: name, phone: staffMember.phone },
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
    // After the staff exist — a linked login is nothing without its link.
    const logins = [];
    for (const spec of STAFF_LOGINS) {
      logins.push({ spec, user: await seedStaffLogin(spec) });
    }

    const counts = {
      users: await prisma.user.count(),
      trucks: await prisma.truck.count(),
      staff: await prisma.staff.count(),
      clients: await prisma.client.count(),
      thirdParties: await prisma.thirdParty.count(),
      payees: await prisma.payee.count(),
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
    for (const { spec, user } of logins) {
      console.warn(`[seed] ${spec.label}:`, user.email, `(staffId=${String(user.staffId)})`);
    }
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
