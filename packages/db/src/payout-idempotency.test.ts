import { CommissionMethod, CrewRole, PayoutRunStatus, ShipmentStatus } from '@eztruckr/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from './actor-context';
import type { ExtendedPrismaClient } from './prisma-client';
import { withDeleted, withHardDelete } from './soft-delete-context';
import { cleanupTestRows, createTestClient, databaseIsReachable, testId } from './test-support';

/**
 * THE load-bearing assertion of the payout model:
 *
 *   "A commission included in a paid run can never be paid again."
 *
 * Soft delete is what makes this genuinely hard. The unique index on
 * (shipmentId, role) is PARTIAL — it only covers live rows — so if a paid
 * commission could be soft-deleted, its slot would open up, a replacement
 * could be computed for the same trip and role, and the same work would be
 * paid twice. The original row would still read as paid, so nothing would
 * look wrong in any report.
 *
 * These tests hit a real database, because the guarantee is enforced by
 * constraints and triggers rather than by application code.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let adminId: string;
let clientId: string;
let staffId: string;

beforeAll(async () => {
  prisma = createTestClient();
  available = await databaseIsReachable(prisma);

  if (!available) {
    console.warn('[payout-idempotency] database unreachable — skipping integration tests');
    return;
  }

  await cleanupTestRows(prisma);

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  await withActor({ userId: adminId }, async () => {
    const client = await prisma.client.create({
      data: { id: testId('client'), code: testId('CLT'), name: 'Integration Test Client' },
    });
    clientId = client.id;

    const crew = await prisma.staff.create({
      data: {
        id: testId('crew'),
        staffCode: testId('CRW'),
        firstName: 'Test',
        lastName: 'Driver',
        eligibleRoles: [CrewRole.DRIVER],
      },
    });
    staffId = crew.id;
  });
});

afterAll(async () => {
  if (available) await cleanupTestRows(prisma);
  await prisma.$disconnect();
});

/** Builds a shipment with one driver commission, paid through a PAID run. */
async function createPaidCommission(suffix: string) {
  return withActor({ userId: adminId }, async () => {
    const shipment = await prisma.shipment.create({
      data: {
        id: testId(`shipment-${suffix}`),
        shipmentNumber: testId(`SHP-${suffix}`),
        status: ShipmentStatus.CLOSED,
        clientId,
        origin: 'Manila',
        destination: 'Batangas',
        grossRate: '18000.0000',
        tpcAmount: '1800.0000',
        netRate: '16200.0000',
        commissionableBase: '12150.0000',
      },
    });

    const run = await prisma.payoutRun.create({
      data: {
        id: testId(`run-${suffix}`),
        runNumber: testId(`RUN-${suffix}`),
        status: PayoutRunStatus.DRAFT,
        periodStart: new Date('2026-01-01T00:00:00Z'),
        periodEnd: new Date('2026-01-31T00:00:00Z'),
      },
    });

    const line = await prisma.payoutLine.create({
      data: {
        id: testId(`line-${suffix}`),
        payoutRunId: run.id,
        staffId,
        grossAmount: '1822.5000',
        netAmount: '1822.5000',
      },
    });

    const commission = await prisma.commission.create({
      data: {
        id: testId(`commission-${suffix}`),
        shipmentId: shipment.id,
        staffId,
        role: CrewRole.DRIVER,
        appliedMethod: CommissionMethod.PERCENT_OF_BASE,
        commissionableBase: '12150.0000',
        appliedRate: '0.1500',
        amount: '1822.5000',
        payoutLineId: line.id,
      },
    });

    // Pay the run last: every guard keys off this transition.
    await prisma.payoutRun.update({
      where: { id: run.id },
      data: { status: PayoutRunStatus.PAID, paidAt: new Date(), paidBy: adminId },
    });

    return { shipment, run, line, commission };
  });
}

describe.runIf(process.env.SKIP_DB_TESTS !== '1')('payout idempotency survives soft delete', () => {
  it('refuses to soft-delete a commission that has been paid', async () => {
    if (!available) return;
    const { commission } = await createPaidCommission('a');

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.softDelete({ id: commission.id }),
      ),
    ).rejects.toThrow(/has been paid and cannot be deleted/i);

    // And it is genuinely still live, not half-deleted.
    const stillThere = await prisma.commission.findFirst({ where: { id: commission.id } });
    expect(stillThere).not.toBeNull();
    expect(stillThere?.deletedAt).toBeNull();
  });

  it('refuses a soft delete issued as raw SQL, not just through the client', async () => {
    if (!available) return;
    const { commission } = await createPaidCommission('b');

    // The extension is convenience; the trigger is the actual guarantee.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "commission" SET "deletedAt" = now() WHERE id = '${commission.id}'`,
      ),
    ).rejects.toThrow(/has been paid and cannot be deleted/i);
  });

  it('keeps a paid commission occupying its payout line, so it cannot be re-paid', async () => {
    if (!available) return;
    const { commission, run } = await createPaidCommission('c');

    const secondLine = await withActor({ userId: adminId }, async () =>
      prisma.payoutLine.create({
        data: {
          id: testId('line-c2'),
          payoutRunId: run.id,
          staffId,
          grossAmount: '1822.5000',
          netAmount: '1822.5000',
        },
      }),
    );

    // Moving the paid commission onto a fresh line is the direct re-pay route.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.update({
          where: { id: commission.id },
          data: { payoutLineId: secondLine.id },
        }),
      ),
    ).rejects.toThrow(/cannot be re-paid/i);

    // Releasing it back to unpaid is the indirect route.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.update({
          where: { id: commission.id },
          data: { payoutLineId: null },
        }),
      ),
    ).rejects.toThrow(/cannot be re-paid/i);
  });

  it('blocks the delete-then-recreate route to paying the same work twice', async () => {
    if (!available) return;
    const { shipment, commission } = await createPaidCommission('d');

    // Soft delete is refused (asserted above), so the (shipment, role) slot is
    // still occupied and a replacement cannot be created. This is the whole
    // point of the partial unique staying partial while the payout link does
    // not.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.commission.create({
          data: {
            id: testId('commission-d2'),
            shipmentId: shipment.id,
            staffId,
            role: CrewRole.DRIVER,
            appliedMethod: CommissionMethod.PERCENT_OF_BASE,
            commissionableBase: '12150.0000',
            appliedRate: '0.1500',
            amount: '1822.5000',
          },
        }),
      ),
    ).rejects.toThrow();

    const live = await prisma.commission.findMany({
      where: { shipmentId: shipment.id, role: CrewRole.DRIVER },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(commission.id);
  });

  it('treats PAID as terminal — the run can be neither voided nor deleted', async () => {
    if (!available) return;
    const { run } = await createPaidCommission('e');

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.payoutRun.update({
          where: { id: run.id },
          data: { status: PayoutRunStatus.VOIDED },
        }),
      ),
    ).rejects.toThrow(/terminal/i);

    await expect(
      withActor({ userId: adminId }, async () => prisma.payoutRun.softDelete({ id: run.id })),
    ).rejects.toThrow(/cannot be deleted/i);
  });

  it('refuses a hard delete of a paid commission or its payout line', async () => {
    if (!available) return;
    const { commission, line } = await createPaidCommission('g');

    // withHardDelete lifts the extension's block, leaving only the database
    // triggers — which must still refuse.
    await expect(
      withHardDelete(async () => prisma.commission.delete({ where: { id: commission.id } })),
    ).rejects.toThrow(/paid payout run and cannot be deleted/i);

    await expect(
      withHardDelete(async () => prisma.payoutLine.delete({ where: { id: line.id } })),
    ).rejects.toThrow(/paid run and cannot be deleted/i);

    const survivor = await prisma.commission.findFirst({ where: { id: commission.id } });
    expect(survivor?.payoutLineId).toBe(line.id);
  });

  it('still counts a paid commission as paid when read with deleted rows included', async () => {
    if (!available) return;
    const { commission, line } = await createPaidCommission('f');

    const seen = await withDeleted(() =>
      prisma.commission.findFirst({ where: { id: commission.id } }),
    );

    expect(seen?.payoutLineId).toBe(line.id);
  });
});

/**
 * The same guarantee, on the other side of the ledger.
 *
 * A commission is indivisible — paid whole or not at all — so one link with a
 * full unique models it. A deduction is DIVISIBLE: a ₱9,000 damage claim
 * against someone earning ₱1,800 a fortnight comes back a slice at a time. It
 * used to be modelled with a single `payoutLineId` plus a `recovered` running
 * total, which meant the link was repointed on every run (losing all but the
 * last recovery) and the total could be incremented twice for the same run —
 * recovering a debt twice and short-changing the crew member.
 *
 * `CrewDeductionRecovery` replaces both. These assertions are why it exists.
 */
describe.runIf(process.env.SKIP_DB_TESTS !== '1')('crew deduction recovery', () => {
  /** A debt, a payout run, and a line to recover against. */
  async function createDebt(suffix: string, amount = '9000.0000') {
    return withActor({ userId: adminId }, async () => {
      const deduction = await prisma.crewDeduction.create({
        data: {
          id: testId(`ded-${suffix}`),
          staffId,
          reason: 'Damaged tyre',
          amount,
        },
      });

      const run = await prisma.payoutRun.create({
        data: {
          id: testId(`drun-${suffix}`),
          runNumber: testId(`DRUN-${suffix}`),
          status: PayoutRunStatus.DRAFT,
          periodStart: new Date('2026-02-01T00:00:00Z'),
          periodEnd: new Date('2026-02-28T00:00:00Z'),
        },
      });

      const line = await prisma.payoutLine.create({
        data: {
          id: testId(`dline-${suffix}`),
          payoutRunId: run.id,
          staffId,
          grossAmount: '1800.0000',
          netAmount: '0.0000',
        },
      });

      return { deduction, run, line };
    });
  }

  async function addLine(suffix: string, runId: string, index: number) {
    return withActor({ userId: adminId }, async () =>
      prisma.payoutLine.create({
        data: {
          id: testId(`dline-${suffix}-${index}`),
          payoutRunId: runId,
          staffId,
          grossAmount: '1800.0000',
          netAmount: '0.0000',
        },
      }),
    );
  }

  it('records one debt recovered in slices across several payout lines', async () => {
    if (!available) return;
    const { deduction, run, line } = await createDebt('multi');
    const second = await addLine('multi', run.id, 2);
    const third = await addLine('multi', run.id, 3);

    for (const [index, target] of [line, second, third].entries()) {
      await withActor({ userId: adminId }, async () =>
        prisma.crewDeductionRecovery.create({
          data: {
            id: testId(`rec-multi-${index}`),
            crewDeductionId: deduction.id,
            payoutLineId: target.id,
            amount: '3000.0000',
          },
        }),
      );
    }

    // The thing the old model could not do: every slice is still there, and
    // each one still names the line that took it.
    const recoveries = await prisma.crewDeductionRecovery.findMany({
      where: { crewDeductionId: deduction.id },
    });

    expect(recoveries).toHaveLength(3);
    expect(recoveries.map((row) => row.payoutLineId).sort()).toEqual(
      [line.id, second.id, third.id].sort(),
    );

    // And the balance is derived from them rather than cached anywhere.
    const total = await prisma.crewDeductionRecovery.aggregate({
      where: { crewDeductionId: deduction.id },
      _sum: { amount: true },
    });

    expect(total._sum.amount?.toString()).toBe('9000');
  });

  it('refuses to recover more than the debt', async () => {
    if (!available) return;
    const { deduction, run, line } = await createDebt('over', '1000.0000');
    const second = await addLine('over', run.id, 2);

    await withActor({ userId: adminId }, async () =>
      prisma.crewDeductionRecovery.create({
        data: {
          id: testId('rec-over-1'),
          crewDeductionId: deduction.id,
          payoutLineId: line.id,
          amount: '800.0000',
        },
      }),
    );

    // 800 + 300 > 1000. Without this the derived balance would go negative and
    // the crew member would be over-collected.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.crewDeductionRecovery.create({
          data: {
            id: testId('rec-over-2'),
            crewDeductionId: deduction.id,
            payoutLineId: second.id,
            amount: '300.0000',
          },
        }),
      ),
    ).rejects.toThrow(/over-recovered/i);
  });

  it('refuses two slices of the same debt on one payout line', async () => {
    if (!available) return;
    const { deduction, line } = await createDebt('dupe');

    await withActor({ userId: adminId }, async () =>
      prisma.crewDeductionRecovery.create({
        data: {
          id: testId('rec-dupe-1'),
          crewDeductionId: deduction.id,
          payoutLineId: line.id,
          amount: '100.0000',
        },
      }),
    );

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.crewDeductionRecovery.create({
          data: {
            id: testId('rec-dupe-2'),
            crewDeductionId: deduction.id,
            payoutLineId: line.id,
            amount: '100.0000',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('refuses a zero or negative recovery', async () => {
    if (!available) return;
    const { deduction, line } = await createDebt('sign');

    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.crewDeductionRecovery.create({
          data: {
            id: testId('rec-sign'),
            crewDeductionId: deduction.id,
            payoutLineId: line.id,
            amount: '-100.0000',
          },
        }),
      ),
    ).rejects.toThrow(/amount_positive/i);
  });

  it('freezes a recovery once its run is paid', async () => {
    if (!available) return;
    const { deduction, run, line } = await createDebt('paid');

    const recovery = await withActor({ userId: adminId }, async () =>
      prisma.crewDeductionRecovery.create({
        data: {
          id: testId('rec-paid'),
          crewDeductionId: deduction.id,
          payoutLineId: line.id,
          amount: '3000.0000',
        },
      }),
    );

    await withActor({ userId: adminId }, async () =>
      prisma.payoutRun.update({
        where: { id: run.id },
        data: { status: PayoutRunStatus.PAID, paidAt: new Date(), paidBy: adminId },
      }),
    );

    // The amount is money that has left the building.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.crewDeductionRecovery.update({
          where: { id: recovery.id },
          data: { amount: '1.0000' },
        }),
      ),
    ).rejects.toThrow(/paid payout run and cannot be altered/i);

    // Soft-deleting it would make the debt look outstanding again, so the same
    // slice could be taken from the crew member a second time.
    await expect(
      withActor({ userId: adminId }, async () =>
        prisma.crewDeductionRecovery.softDelete({ id: recovery.id }),
      ),
    ).rejects.toThrow(/has been paid and cannot be deleted/i);

    await expect(
      withHardDelete(async () =>
        prisma.crewDeductionRecovery.delete({ where: { id: recovery.id } }),
      ),
    ).rejects.toThrow(/paid payout run and cannot be deleted/i);

    const survivor = await prisma.crewDeductionRecovery.findFirst({ where: { id: recovery.id } });
    expect(survivor?.amount.toString()).toBe('3000');
  });
});

/**
 * Which rule paid this?
 *
 * A commission froze everything needed to CHECK its figure — the rate, the
 * method, a formula's expression and inputs — but not which rule produced it.
 * With several rules able to carry the same rate at different scopes, that was
 * answerable only by inference, and ambiguous exactly when somebody is
 * disputing a payout.
 *
 * The id and the name are frozen as a pair: following the id gives the rule as
 * it stands today, which is the very thing the frozen name prevents.
 */
describe.runIf(process.env.SKIP_DB_TESTS !== '1')('a commission records its rule', () => {
  async function createRule(suffix: string, name: string) {
    return withActor({ userId: adminId }, async () =>
      prisma.commissionRule.create({
        data: {
          id: testId(`rule-${suffix}`),
          name,
          role: CrewRole.DRIVER,
          method: CommissionMethod.PERCENT_OF_BASE,
          rate: '0.1500',
          effectiveFrom: new Date('2026-01-01T00:00:00Z'),
        },
      }),
    );
  }

  async function createCommission(suffix: string, rule: { id: string; name: string } | null) {
    return withActor({ userId: adminId }, async () => {
      const shipment = await prisma.shipment.create({
        data: {
          id: testId(`rshipment-${suffix}`),
          shipmentNumber: testId(`RSHP-${suffix}`),
          status: ShipmentStatus.PENDING_LIQUIDATION,
          clientId,
          origin: 'Manila',
          destination: 'Batangas',
          grossRate: '18000.0000',
          netRate: '16200.0000',
        },
      });

      return prisma.commission.create({
        data: {
          id: testId(`rcommission-${suffix}`),
          shipmentId: shipment.id,
          staffId,
          role: CrewRole.DRIVER,
          appliedMethod: CommissionMethod.PERCENT_OF_BASE,
          appliedRuleId: rule?.id ?? null,
          appliedRuleName: rule?.name ?? null,
          commissionableBase: '12150.0000',
          appliedRate: '0.1500',
          amount: '1822.5000',
        },
      });
    });
  }

  it('keeps the rule name it was computed with, even after the rule is renamed', async () => {
    if (!available) return;
    const rule = await createRule('rename', 'Northport 2026 driver');
    const commission = await createCommission('rename', rule);

    await withActor({ userId: adminId }, async () =>
      prisma.commissionRule.update({
        where: { id: rule.id },
        data: { name: 'Northport 2027 driver' },
      }),
    );

    const frozen = await prisma.commission.findFirst({ where: { id: commission.id } });

    // The voucher still reads as it did. Joining would have relabelled it.
    expect(frozen?.appliedRuleName).toBe('Northport 2026 driver');
    // And the id still traces to the rule, which now reads differently.
    expect(frozen?.appliedRuleId).toBe(rule.id);

    const current = await prisma.commissionRule.findFirst({ where: { id: rule.id } });
    expect(current?.name).toBe('Northport 2027 driver');
  });

  it('still resolves the rule after it is soft-deleted, so the trail is walkable', async () => {
    if (!available) return;
    const rule = await createRule('deleted', 'Retired driver rule');
    const commission = await createCommission('deleted', rule);

    await withActor({ userId: adminId }, async () =>
      prisma.commissionRule.softDelete({ id: rule.id }),
    );

    // To-one relations are deliberately not filtered by the soft-delete
    // extension — this is the case that exists for.
    const withRule = await prisma.commission.findFirst({
      where: { id: commission.id },
      include: { appliedRule: true },
    });

    expect(withRule?.appliedRule?.id).toBe(rule.id);
    expect(withRule?.appliedRule?.deletedAt).not.toBeNull();
  });

  it('refuses an id without a name, or a name without an id', async () => {
    if (!available) return;
    const rule = await createRule('pair', 'Pairing rule');

    await expect(
      createCommission('pair-idonly', { id: rule.id, name: null as never }),
    ).rejects.toThrow(/applied_rule_id_and_name_together/i);

    await expect(
      createCommission('pair-nameonly', { id: null as never, name: 'orphaned label' }),
    ).rejects.toThrow(/applied_rule_id_and_name_together/i);
  });

  it('allows both null, for rows computed before the columns existed', async () => {
    if (!available) return;
    const commission = await createCommission('legacy', null);

    expect(commission.appliedRuleId).toBeNull();
    expect(commission.appliedRuleName).toBeNull();
  });
});
