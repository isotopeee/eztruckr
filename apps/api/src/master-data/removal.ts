import { withHardDelete } from '@eztruckr/db';
import type { ReferenceCount, RemovalResult } from '@eztruckr/types';

/**
 * Reference-aware removal, shared by every master data service.
 *
 * THE RULE. A record that nothing refers to can leave. A record history
 * depends on cannot, because removing it would either break a foreign key or —
 * worse — quietly change what an old shipment, voucher or payout says. Such a
 * record is DEACTIVATED instead: still valid on everything already recorded,
 * no longer offered for new work.
 *
 * That distinction is exactly the `isActive` / `deletedAt` split the schema
 * insists on, applied at the moment a user clicks Delete and does not yet know
 * which of the two they are asking for. The caller is always told which
 * happened, so nobody is left believing a truck is gone while it still prints
 * on last month's paperwork.
 *
 * Every business foreign key in this schema is ON DELETE RESTRICT, so the
 * database is a genuine second line of defence: if a probe below were ever
 * missed, a hard delete would fail loudly rather than cascade.
 */

/** One thing that might refer to a record, and how to count live references. */
export interface ReferenceProbe {
  /** Plural, human-readable, as it will appear in the API response. */
  entity: string;
  count: () => Promise<number>;
}

/** Counts every probe, keeping only those that actually found something. */
export async function collectReferences(
  probes: readonly ReferenceProbe[],
): Promise<ReferenceCount[]> {
  const counts = await Promise.all(
    probes.map(async (probe) => ({ entity: probe.entity, count: await probe.count() })),
  );

  return counts.filter((reference) => reference.count > 0);
}

export interface RemovalPlan {
  probes: readonly ReferenceProbe[];
  /** Set isActive = false. Used when something still refers to the record. */
  deactivate: () => Promise<unknown>;
  /** Set deletedAt. The default outcome for an unreferenced record. */
  softDelete: () => Promise<unknown>;
  /**
   * A real SQL DELETE, offered only where the domain says a record may
   * genuinely never have existed — expense categories. Omitted everywhere
   * else, which is why every other entity soft-deletes at most.
   */
  hardDelete?: () => Promise<unknown>;
}

export async function removeRecord(plan: RemovalPlan): Promise<RemovalResult> {
  const references = await collectReferences(plan.probes);

  if (references.length > 0) {
    await plan.deactivate();
    return { outcome: 'DEACTIVATED', references };
  }

  if (plan.hardDelete) {
    // withHardDelete is the only way past the soft-delete extension's refusal
    // to run a DELETE, and it is deliberately awkward to reach. Reaching it
    // here is the deliberate, narrow exception the extension's own comment
    // anticipates.
    await withHardDelete(async () => {
      await plan.hardDelete?.();
    });
    return { outcome: 'HARD_DELETED', references: [] };
  }

  await plan.softDelete();
  return { outcome: 'SOFT_DELETED', references: [] };
}
