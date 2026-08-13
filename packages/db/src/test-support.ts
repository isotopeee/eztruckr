import { createPrismaClient, type ExtendedPrismaClient } from './prisma-client';
import { testUuid } from './uuid';

/**
 * Helpers shared by the integration tests. Not exported from the package
 * index — this is test scaffolding, not part of the public surface.
 */

/** Every row created by a test carries this prefix so cleanup can find it. */
export const TEST_PREFIX = '00000001-';

export function testId(name: string): string {
  return testUuid('00000001', name);
}

export async function databaseIsReachable(client: ExtendedPrismaClient): Promise<boolean> {
  try {
    await client.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Tables to clear, in dependency order (children first).
 */
const CLEANUP_ORDER = [
  'commission',
  // Before payout_line and crew_deduction, both of which it references.
  'crew_deduction_recovery',
  'payout_line',
  'payout_run',
  'additional_charge',
  'billable_expense',
  // Was missing entirely, so `itest-` rows accumulated from the phase that
  // introduced it. Noticed because it now references payee, which cannot be
  // cleared while a row still names it.
  'company_paid_expense',
  'liquidation_line',
  // Before liquidation, which it references; and before crew_deduction, which
  // a carried settlement points at.
  'liquidation_history',
  'settlement',
  'liquidation',
  'allowance',
  'crew_deduction',
  'adjustment',
  'receipt',
  'shipment',
  'commission_rule',
  'expense_category',
  'route',
  'third_party',
  // After liquidation_line and company_paid_expense, the two that name it.
  'payee',
  'client',
  'staff',
  'truck',
  'user_profile',
  'user',
] as const;

/**
 * Remove every row a test created.
 *
 * Uses `session_replication_role = replica` to suspend triggers for the
 * duration, because the payout guards deliberately refuse to delete a paid
 * commission — which is the very thing the tests create. This is test
 * teardown only; application code can never reach a hard delete at all.
 */
export async function cleanupTestRows(client: ExtendedPrismaClient): Promise<void> {
  await client.$executeRawUnsafe(`SET session_replication_role = replica`);
  try {
    for (const table of CLEANUP_ORDER) {
      await client.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE id::text LIKE '${TEST_PREFIX}%'`,
      );
    }
  } finally {
    await client.$executeRawUnsafe(`SET session_replication_role = DEFAULT`);
  }
}

export function createTestClient(): ExtendedPrismaClient {
  return createPrismaClient();
}
