import { describe, expect, it, vi } from 'vitest';
import { collectReferences, removeRecord } from './removal';

/**
 * The rule these cover is the one a user actually feels: pressing Delete on a
 * truck that has hauled something must not remove it, and must say so.
 */

function plan(overrides: Partial<Parameters<typeof removeRecord>[0]> = {}) {
  return {
    probes: [],
    deactivate: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(1),
    ...overrides,
  };
}

describe('collectReferences', () => {
  it('reports only the probes that found something', async () => {
    const references = await collectReferences([
      { entity: 'shipments', count: () => Promise.resolve(3) },
      { entity: 'commissions', count: () => Promise.resolve(0) },
      { entity: 'allowances', count: () => Promise.resolve(1) },
    ]);

    expect(references).toEqual([
      { entity: 'shipments', count: 3 },
      { entity: 'allowances', count: 1 },
    ]);
  });

  it('returns nothing when no probe matches', async () => {
    expect(
      await collectReferences([{ entity: 'shipments', count: () => Promise.resolve(0) }]),
    ).toEqual([]);
  });
});

describe('removeRecord', () => {
  it('soft-deletes an unreferenced record', async () => {
    const p = plan();

    await expect(removeRecord(p)).resolves.toEqual({ outcome: 'SOFT_DELETED', references: [] });
    expect(p.softDelete).toHaveBeenCalledOnce();
    expect(p.deactivate).not.toHaveBeenCalled();
  });

  it('deactivates a referenced record instead of deleting it', async () => {
    const p = plan({
      probes: [{ entity: 'shipments', count: () => Promise.resolve(2) }],
    });

    await expect(removeRecord(p)).resolves.toEqual({
      outcome: 'DEACTIVATED',
      references: [{ entity: 'shipments', count: 2 }],
    });
    expect(p.deactivate).toHaveBeenCalledOnce();
    expect(p.softDelete).not.toHaveBeenCalled();
  });

  it('hard-deletes only when that is offered AND nothing refers to the record', async () => {
    const hardDelete = vi.fn().mockResolvedValue(undefined);
    const p = plan({ hardDelete });

    await expect(removeRecord(p)).resolves.toEqual({ outcome: 'HARD_DELETED', references: [] });
    expect(hardDelete).toHaveBeenCalledOnce();
    expect(p.softDelete).not.toHaveBeenCalled();
  });

  it('never hard-deletes a referenced record, even where hard delete is offered', async () => {
    // This is the expense category case: deletable in principle, but the
    // moment a liquidation line points at it, it is part of that record.
    const hardDelete = vi.fn().mockResolvedValue(undefined);
    const p = plan({
      hardDelete,
      probes: [{ entity: 'liquidation lines', count: () => Promise.resolve(1) }],
    });

    await expect(removeRecord(p)).resolves.toMatchObject({ outcome: 'DEACTIVATED' });
    expect(hardDelete).not.toHaveBeenCalled();
    expect(p.deactivate).toHaveBeenCalledOnce();
  });

  it('deactivates when any one of several probes matches', async () => {
    const p = plan({
      probes: [
        { entity: 'shipments', count: () => Promise.resolve(0) },
        { entity: 'commissions', count: () => Promise.resolve(0) },
        { entity: 'payout lines', count: () => Promise.resolve(7) },
      ],
    });

    await expect(removeRecord(p)).resolves.toEqual({
      outcome: 'DEACTIVATED',
      references: [{ entity: 'payout lines', count: 7 }],
    });
  });
});
