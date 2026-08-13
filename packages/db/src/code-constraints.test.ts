import {
  AdjustmentDirection,
  CommissionMethod,
  CrewRole,
  DisbursementMode,
  LiquidationHistoryAction,
  LiquidationStatus,
  PayoutRunStatus,
  RETIRED_LIQUIDATION_STATUS_CODES,
  SettlementStatus,
  ShipmentStatus,
  UserRole,
} from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExtendedPrismaClient } from './prisma-client';
import { createTestClient, databaseIsReachable } from './test-support';

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
  { constraint: 'crew_member_eligible_roles_valid', codes: Object.values(CrewRole) },
  { constraint: 'commission_rule_role_code_valid', codes: Object.values(CrewRole) },
  { constraint: 'commission_rule_method_code_valid', codes: Object.values(CommissionMethod) },
  { constraint: 'shipment_status_code_valid', codes: Object.values(ShipmentStatus) },
  { constraint: 'liquidation_status_code_valid', codes: Object.values(LiquidationStatus) },
  {
    constraint: 'liquidation_history_action_code_valid',
    codes: Object.values(LiquidationHistoryAction),
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
  { constraint: 'commission_role_code_valid', codes: Object.values(CrewRole) },
  { constraint: 'commission_applied_method_code_valid', codes: Object.values(CommissionMethod) },
  { constraint: 'payout_run_status_code_valid', codes: Object.values(PayoutRunStatus) },
];

interface ConstraintRow {
  conname: string;
  definition: string;
}

let definitions = new Map<string, string>();

beforeAll(async () => {
  prisma = createTestClient();
  available = await databaseIsReachable(prisma);
  if (!available) {
    console.warn('[code-constraints] database unreachable — skipping integration tests');
    return;
  }

  const rows = await prisma.$queryRaw<ConstraintRow[]>`
    SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
     WHERE contype = 'c'
       AND connamespace = 'public'::regnamespace
  `;

  definitions = new Map(rows.map((row) => [row.conname, row.definition]));
});

afterAll(async () => {
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
      'crew_member.eligibleRoles',
      'commission_rule.role',
      'commission_rule.method',
      'shipment.status',
      'liquidation.status',
      'liquidation_history.action',
      'settlement.status',
      'allowance.disbursementMode',
      'settlement.disbursementMode',
      'adjustment.direction',
      'commission.role',
      'commission.appliedMethod',
      'payout_run.status',
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
        VALUES ('itest-nullcreator', 'itest-NULLPLT', true, now(), now(), NULL)
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

    // 26 business tables, minus user and user_profile. The last two are
    // liquidation_history and settlement, added in Phase 5.
    expect(rows).toHaveLength(24);
    expect(rows.some((row) => row.conname.startsWith('user_'))).toBe(false);
  });
});

describe('a retired code stays out of the database as well as the type', () => {
  it('rejects a liquidation written with the withdrawn FINALIZED code', async () => {
    if (!available) return;

    // 3 was FINALIZED. It is gone from the code set AND from the CHECK, so a
    // row cannot be written with it by any path — including the raw SQL that
    // bypasses every TypeScript guard in the system.
    expect(RETIRED_LIQUIDATION_STATUS_CODES).toContain(3);

    await expect(
      prisma.$executeRawUnsafe(`
        INSERT INTO "liquidation" (id, "shipmentId", status, "createdAt", "updatedAt", "createdBy")
        SELECT 'itest-retired-status', id, 3, now(), now(), 'itest'
          FROM "shipment" LIMIT 1
      `),
    ).rejects.toThrow(/liquidation_status_code_valid/i);
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
