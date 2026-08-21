import {
  AdjustmentDirection,
  AllowanceRequestStatus,
  CommissionMethod,
  CrewRole,
  DisbursementMode,
  LiquidationHistoryAction,
  LiquidationStatus,
  PayeeType,
  PayoutRunStatus,
  SettlementStatus,
  ShipmentStatus,
  StaffRole,
  UserRole,
} from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExtendedPrismaClient } from './prisma-client';
import {
  cleanupTestRows,
  createTestClient,
  databaseIsReachable,
  TEST_PREFIX,
  testId,
} from './test-support';

/**
 * Drift guard for the one unavoidable duplication in the system.
 *
 * Code values are declared in @eztruckr/types, but a migration is static SQL
 * and cannot import from it, so the CHECK constraints repeat the numbers.
 * This reads the constraints back out of the Postgres catalog and compares
 * them against the TypeScript definitions.
 *
 * If this fails, either a code was appended in TypeScript without a migration
 * to widen the constraint (writes will be rejected at runtime), or the
 * constraint was widened without the code being declared (unreadable rows can
 * be written). Both are worth failing a build over.
 */

let prisma: ExtendedPrismaClient;
let available = false;

/** Constraint name -> the code set it is supposed to enforce. */
const EXPECTED: ReadonlyArray<{ constraint: string; codes: readonly number[] }> = [
  { constraint: 'user_role_code_valid', codes: Object.values(UserRole) },
  // The superset: everything a person may be engaged as.
  { constraint: 'staff_eligible_roles_valid', codes: Object.values(StaffRole) },
  // The crew SUBSET, and named for it. These two are the only code constraints
  // that deliberately refuse a code the column's own set defines: a dispatch
  // manager is valid staff and can never hold a commission.
  { constraint: 'commission_rule_role_is_a_crew_role', codes: Object.values(CrewRole) },
  { constraint: 'commission_rule_method_code_valid', codes: Object.values(CommissionMethod) },
  { constraint: 'shipment_status_code_valid', codes: Object.values(ShipmentStatus) },
  { constraint: 'liquidation_status_code_valid', codes: Object.values(LiquidationStatus) },
  {
    constraint: 'liquidation_history_action_code_valid',
    codes: Object.values(LiquidationHistoryAction),
  },
  {
    constraint: 'allowance_request_status_code_valid',
    codes: Object.values(AllowanceRequestStatus),
  },
  { constraint: 'settlement_status_code_valid', codes: Object.values(SettlementStatus) },
  {
    constraint: 'allowance_disbursement_mode_code_valid',
    codes: Object.values(DisbursementMode),
  },
  {
    constraint: 'settlement_disbursement_mode_code_valid',
    codes: Object.values(DisbursementMode),
  },
  { constraint: 'adjustment_direction_code_valid', codes: Object.values(AdjustmentDirection) },
  { constraint: 'commission_role_is_a_crew_role', codes: Object.values(CrewRole) },
  { constraint: 'commission_applied_method_code_valid', codes: Object.values(CommissionMethod) },
  { constraint: 'payout_run_status_code_valid', codes: Object.values(PayoutRunStatus) },
  { constraint: 'payee_type_code_valid', codes: Object.values(PayeeType) },
];

interface ConstraintRow {
  conname: string;
  definition: string;
}

let definitions = new Map<string, string>();
/** A real user, because `createdBy` is a foreign key as well as a CHECK. */
let actorId: string;

beforeAll(async () => {
  prisma = createTestClient();
  available = await databaseIsReachable(prisma);
  if (!available) {
    console.warn('[code-constraints] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('The test database is not seeded — see prepareTestDatabase()');
  actorId = admin.id;

  const rows = await prisma.$queryRaw<ConstraintRow[]>`
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE contype = 'c'
       AND connamespace = 'public'::regnamespace
  `;

  definitions = new Map(rows.map((row) => [row.conname, row.definition]));
});

afterAll(async () => {
  // This file used to create nothing and so needed no teardown. The liquidation
  // status fixtures below are real rows, and suites run sequentially, so
  // clearing the block here keeps the next run starting from the same place.
  if (available) await cleanupTestRows(prisma);
  await prisma.$disconnect();
});

/** Every integer appearing in a constraint definition. */
function numbersIn(definition: string): number[] {
  return [...definition.matchAll(/\d+/g)].map((match) => Number(match[0]));
}

describe('database CHECK constraints match the TypeScript code sets', () => {
  it.each(EXPECTED)('$constraint accepts exactly the declared codes', ({ constraint, codes }) => {
    if (!available) return;

    const definition = definitions.get(constraint);
    expect(definition, `constraint ${constraint} is missing from the database`).toBeDefined();

    const found = new Set(numbersIn(definition ?? ''));
    const expected = new Set(codes);

    // Same set both ways: nothing declared but unenforced, nothing enforced
    // but undeclared.
    expect([...found].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
  });

  it('documents every code column with a SQL comment', async () => {
    if (!available) return;

    const commented = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT c.relname AS table_name, a.attname AS column_name
        FROM pg_description d
        JOIN pg_class c ON c.oid = d.objoid
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid
       WHERE c.relnamespace = 'public'::regnamespace
         AND d.description LIKE '%Code set%'
    `;

    const documented = new Set(commented.map((row) => `${row.table_name}.${row.column_name}`));

    // Someone reading raw SQL must be able to decode every code column.
    for (const column of [
      'user.role',
      'staff.eligibleRoles',
      'commission_rule.role',
      'commission_rule.method',
      'shipment.status',
      'liquidation.status',
      'liquidation_history.action',
      'allowance_request.status',
      'settlement.status',
      'allowance.disbursementMode',
      'settlement.disbursementMode',
      'adjustment.direction',
      'commission.role',
      'commission.appliedMethod',
      'payout_run.status',
      'payee.payeeType',
    ]) {
      expect(documented.has(column), `${column} has no code-set comment`).toBe(true);
    }
  });
});

describe('createdBy stays mandatory in the database', () => {
  it('rejects an insert with a null createdBy, despite the column being nullable', async () => {
    if (!available) return;

    // Nullable to Prisma so callers never have to pass it; still NOT NULL in
    // Postgres via a CHECK. Written as raw SQL because the audit extension
    // would otherwise fill the value in for us.
    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "truck" (id, "plateNumber", "isActive", "createdAt", "updatedAt", "createdBy")
        VALUES ('${testId('nullcreator')}', 'itest-NULLPLT', true, now(), now(), NULL)
      `),
    ).rejects.toThrow(/created_by_required/i);
  });

  it('applies that CHECK to every business table except user and user_profile', async () => {
    if (!available) return;

    const rows = await prisma.$queryRaw<{ conname: string }[]>`
      SELECT conname FROM pg_constraint
       WHERE contype = 'c'
         AND connamespace = 'public'::regnamespace
         AND conname LIKE '%_created_by_required'
    `;

    // 30 business tables, minus user and user_profile. The most recent is
    // allowance_request; before it, staff_invitation.
    //
    // Bumping this number is the intended way to add a table — the assertion
    // exists so that forgetting the CHECK fails here rather than surfacing
    // years later as a row nobody can attribute.
    expect(rows).toHaveLength(28);
    expect(rows.some((row) => row.conname.startsWith('user_'))).toBe(false);
  });
});

describe('an unallocated code stays out of the database as well as the type', () => {
  /**
   * The liquidation needs a shipment to hang off, and this MAKES ONE rather
   * than borrowing whichever row happens to exist.
   *
   * It used to read `SELECT id FROM "shipment" LIMIT 1`, which quietly inserted
   * nothing — and therefore asserted nothing — in any database with no
   * shipments in it. That went unnoticed while the suites ran against the
   * development database, where somebody's hand-made trips were always lying
   * around. Against a dedicated test database it failed on the first run, which
   * is the whole argument for having one.
   */
  async function shipmentToHangOff(): Promise<string> {
    const clientId = testId('bad-status-client');
    const shipmentId = testId('bad-status-shipment');

    await prisma.$executeRawUnsafe(`
      INSERT INTO "client" (id, name, "isActive", "createdAt", "updatedAt", "createdBy")
      VALUES ('${clientId}', 'Code constraint fixture', true, now(), now(), '${actorId}')
      ON CONFLICT (id) DO NOTHING
    `);

    await prisma.$executeRawUnsafe(`
      INSERT INTO "shipment"
        (id, "shipmentNumber", status, "clientId", origin, destination,
         "grossRate", "createdAt", "updatedAt", "createdBy")
      VALUES ('${shipmentId}', '${TEST_PREFIX}BADSTATUS', ${ShipmentStatus.DRAFT},
              '${clientId}', 'Manila', 'Batangas', 0, now(), now(), '${actorId}')
      ON CONFLICT (id) DO NOTHING
    `);

    return shipmentId;
  }

  it('rejects a liquidation written with a code the set does not define', async () => {
    if (!available) return;

    // 4 is one past the highest allocated LiquidationStatus, and is exactly
    // where PENDING sat before Phase 5 renumbered the set. A row cannot be
    // written with it by any path — including the raw SQL that bypasses every
    // TypeScript guard in the system.
    expect(Object.values(LiquidationStatus)).not.toContain(4);

    const shipmentId = await shipmentToHangOff();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "liquidation" (id, "shipmentId", status, "createdAt", "updatedAt", "createdBy")
        VALUES ('${testId('bad-status')}', '${shipmentId}', 4, now(), now(), '${actorId}')
      `),
    ).rejects.toThrow(/liquidation_status_code_valid/i);
  });

  /**
   * The companion the old form could not have: an ALLOCATED code goes in.
   * Without this, a constraint that rejected everything would pass the test
   * above for entirely the wrong reason.
   */
  it('accepts one written with a code the set does define', async () => {
    if (!available) return;

    const shipmentId = await shipmentToHangOff();

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "liquidation" (id, "shipmentId", status, "createdAt", "updatedAt", "createdBy")
        VALUES ('${testId('good-status')}', '${shipmentId}', ${LiquidationStatus.PENDING},
                now(), now(), '${actorId}')
      `),
    ).resolves.toBe(1);
  });
});

describe('no native Postgres enum types exist', () => {
  it('stores every enumerated value as smallint instead', async () => {
    if (!available) return;

    const enumTypes = await prisma.$queryRaw<{ typname: string }[]>`
      SELECT typname FROM pg_type
       WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace
    `;

    expect(enumTypes).toEqual([]);
  });
});
