import { createPrismaClient, type ExtendedPrismaClient } from './prisma-client';
import { testUuid } from './uuid';

/** The client Prisma hands an interactive transaction: no nested `$transaction`. */
type TransactionClient = Omit<
  ExtendedPrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

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
  await withTriggersSuspended(client, async (tx) => {
    for (const table of CLEANUP_ORDER) {
      await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE id::text LIKE '${TEST_PREFIX}%'`);
    }
  });
}

/**
 * Run `fn` with the payout guards suspended, on ONE connection, reverting even
 * if it throws.
 *
 * `session_replication_role` is a per-CONNECTION setting, and Prisma hands each
 * query whichever pooled connection is free. Issuing the three statements
 * separately —
 *
 *     SET session_replication_role = replica     -- lands on connection A
 *     DELETE ...                                 -- lands on B, C, D
 *     SET session_replication_role = DEFAULT     -- lands on B
 *
 * — leaves connection A with triggers disabled for the rest of the run. Every
 * later query routed to it silently skips every trigger in the schema, so
 * `softDelete` on a paid commission succeeds, PAID stops being terminal, and a
 * debt can be over-recovered. Nothing fails loudly; the guards simply are not
 * there, and only for the queries unlucky enough to land on that connection.
 *
 * That is not hypothetical — it is what made `payout-idempotency.test.ts` fail
 * in CI while passing locally. Sequential use keeps the pool at one connection,
 * so a laptop run never fans out far enough to split the pair.
 *
 * Two things fix it, and both are needed. The interactive transaction pins
 * every statement to a single connection; `SET LOCAL` scopes the change to that
 * transaction, so it reverts on commit AND on rollback, with no `finally` to
 * forget. CHECK constraints and unique indexes are unaffected either way —
 * `replica` suspends triggers only, which is why constraint-backed assertions
 * kept passing while every trigger-backed one broke.
 */
export async function withTriggersSuspended<T>(
  client: ExtendedPrismaClient,
  fn: (tx: TransactionClient) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
    return fn(tx as TransactionClient);
  });
}

export function createTestClient(): ExtendedPrismaClient {
  return createPrismaClient();
}
