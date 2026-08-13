import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  CrewRole,
  LiquidationStatus,
  ShipmentStatus,
  isCommissionMethod,
  isCrewRole,
  shipmentStatusAfterLiquidationMilestone,
  shipmentStatusAtLeast,
  type CommissionComputation,
  type Commission as CommissionResponse,
  type CrewRole as CrewRoleCode,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { computeCommissionChain, type CommissionChain } from './commission-chain';
import { CommissionComputationError } from './commission-errors';
import { runCommissionStrategy, type StrategyRule } from './commission-strategies';
import { resolveCommissionRule } from './rule-resolver';

/**
 * THE single source of truth for commission arithmetic.
 *
 * Nothing else in the codebase multiplies a base by a rate. The pure pieces
 * live beside this file — the chain, the five strategies, the rule resolver,
 * the formula evaluator — and this class is what connects them to the
 * database: it loads the inputs, calls them in order, and freezes the results.
 *
 * FREEZING is the point of the write. Every figure the computation depended on
 * is copied onto the rows it produced: the gas rate onto the shipment, the
 * rate and method onto each commission, and for a formula rule the expression
 * and the field values it read. After this runs, editing a CommissionRule or
 * the system gas rate cannot move a single peso that has already been
 * computed. That is what makes a payout defensible months later.
 */

/** What Prisma gives us, with everything the chain and strategies need. */
const SHIPMENT_INCLUDE = {
  billableExpenses: { select: { amount: true, isCommissionable: true } },
  additionalCharges: { select: { amount: true, isCommissionable: true } },
  liquidations: { select: { status: true } },
  commissions: { select: { id: true, payoutLineId: true, role: true } },
} satisfies Prisma.ShipmentInclude;

type ShipmentWithChain = Prisma.ShipmentGetPayload<{ include: typeof SHIPMENT_INCLUDE }>;

interface SlotAssignment {
  readonly role: CrewRoleCode;
  readonly crewMemberId: string;
}

@Injectable()
export class CommissionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Computes and stores the commissions for one shipment.
   *
   * Replaces an earlier computation when one exists and none of it has been
   * paid — a charge discovered late is a normal thing, and re-running is how
   * the base catches up. Once any commission on the trip is attached to a
   * payout line, the whole computation is closed: the money has left, and
   * changing the figure behind it would leave the voucher and the ledger
   * disagreeing.
   */
  async computeForShipment(shipmentId: string): Promise<CommissionComputation> {
    const shipment = await this.loadShipment(shipmentId);

    this.assertComputable(shipment);

    const paid = shipment.commissions.filter((row) => row.payoutLineId !== null);

    if (paid.length > 0) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has ${paid.length} commission(s) already paid, so its commissions can no longer be recomputed.`,
      );
    }

    const gasDeductionRate = await this.resolveGasDeductionRate(shipment);
    const chain = this.buildChain(shipment, gasDeductionRate);
    const slots = this.assignedSlots(shipment);

    if (slots.length === 0) {
      throw new UnprocessableEntityException(
        `Shipment ${shipment.shipmentNumber} has no driver or helper assigned, so there is nothing to pay.`,
      );
    }

    const computed = await this.computeSlots(shipment, chain, gasDeductionRate, slots);
    const recomputed = shipment.commissions.length > 0;

    const advancedTo = this.statusAfterComputing(shipment);

    const commissions = await this.prisma.client.$transaction(async (tx) => {
      if (recomputed) {
        // Superseded, not erased: the old rows stay readable under
        // "view deleted" so a changed figure can be explained.
        await tx.commission.softDelete({ shipmentId });
      }

      await tx.shipment.update({
        where: { id: shipmentId },
        data: {
          appliedGasDeductionRate: gasDeductionRate,
          commissionableCharges: chain.commissionableCharges,
          grossForCommission: chain.grossForCommission,
          gasDeductionAmount: chain.gasDeductionAmount,
          commissionableBase: chain.commissionableBase,
          commissionsComputedAt: new Date(),
          ...(advancedTo === null ? {} : { status: advancedTo }),
        },
      });

      const rows = [];

      for (const entry of computed) {
        rows.push(
          await tx.commission.create({
            data: {
              shipmentId,
              crewMemberId: entry.crewMemberId,
              role: entry.role,
              appliedMethod: entry.rule.method,
              // Frozen as a pair: the id to trace, the name as it reads now.
              // Following the id later gives today's rule, which is exactly
              // what the frozen name is here to prevent.
              appliedRuleId: entry.rule.id,
              appliedRuleName: entry.rule.name,
              commissionableBase: chain.commissionableBase,
              appliedRate: entry.result.effectiveRate,
              amount: entry.result.amount,
              appliedFormulaExpression: entry.result.formula?.expression ?? null,
              appliedFormulaFields: entry.result.formula?.resolvedFields ?? undefined,
            },
            include: { crewMember: { select: { firstName: true, lastName: true } } },
          }),
        );
      }

      return rows;
    });

    return {
      shipmentId,
      chain: {
        netRate: shipment.netRate.toString(),
        commissionableCharges: chain.commissionableCharges,
        grossForCommission: chain.grossForCommission,
        appliedGasDeductionRate: gasDeductionRate,
        gasDeductionAmount: chain.gasDeductionAmount,
        commissionableBase: chain.commissionableBase,
      },
      commissions: commissions.map((row) => toCommissionResponse(row, shipment.shipmentNumber)),
      recomputed,
      statusAdvancedTo: advancedTo,
    };
  }

  /** The computed commissions on a shipment, newest computation only. */
  async listForShipment(shipmentId: string): Promise<CommissionResponse[]> {
    const rows = await this.prisma.client.commission.findMany({
      where: { shipmentId },
      orderBy: { role: 'asc' },
      include: {
        crewMember: { select: { firstName: true, lastName: true } },
        shipment: { select: { shipmentNumber: true } },
      },
    });

    return rows.map((row) => toCommissionResponse(row, row.shipment.shipmentNumber));
  }

  /**
   * Everything owed to one crew member, for the portal and for payout.
   *
   * Scoping is the caller's responsibility to pass correctly, and a crew
   * session may only ever pass its own id — enforced in the controller, where
   * the session is.
   */
  async listForCrewMember(crewMemberId: string): Promise<CommissionResponse[]> {
    const rows = await this.prisma.client.commission.findMany({
      where: { crewMemberId },
      orderBy: { computedAt: 'desc' },
      include: {
        crewMember: { select: { firstName: true, lastName: true } },
        shipment: { select: { shipmentNumber: true } },
      },
    });

    return rows.map((row) => toCommissionResponse(row, row.shipment.shipmentNumber));
  }

  // -------------------------------------------------------------------------

  private async loadShipment(shipmentId: string): Promise<ShipmentWithChain> {
    const shipment = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId },
      include: SHIPMENT_INCLUDE,
    });

    if (!shipment) {
      throw new NotFoundException(`No shipment with id ${shipmentId}`);
    }

    return shipment;
  }

  /**
   * Commissions are computed once the trip is done and its charges are known.
   * Earlier than that the base is still moving, and a frozen figure that was
   * never final is worse than no figure at all.
   */
  private assertComputable(shipment: ShipmentWithChain): void {
    const status = shipment.status;

    if (!isShipmentStatusCode(status)) {
      throw new UnprocessableEntityException(`Shipment ${shipment.id} has an unrecognised status.`);
    }

    if (!shipmentStatusAtLeast(status, ShipmentStatus.PENDING_LIQUIDATION)) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has not been delivered yet, so its commission base is not final.`,
      );
    }

    if (status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is closed and can no longer be recomputed.`,
      );
    }
  }

  /**
   * The per-shipment override if one was recorded, otherwise the system-wide
   * default. Whichever it is gets frozen onto `appliedGasDeductionRate` by the
   * caller, so a later change to the setting cannot move this trip's base.
   *
   * Reads the INPUT column, never the frozen output. That is what makes this
   * correct on a recompute: a deliberate override survives, because it is
   * still sitting in `gasRateOverride`, while a shipment that simply took the
   * default picks up today's default rather than the copy frozen last time.
   * A corrected system rate can therefore reach a shipment when somebody asks
   * for it, and only then.
   *
   * These were one column until the split migration, with the reason string
   * left to tell the two cases apart. Reading the input directly means the
   * distinction is structural and this method no longer has to infer it.
   */
  private async resolveGasDeductionRate(shipment: ShipmentWithChain): Promise<string> {
    if (shipment.gasRateOverride !== null) {
      return shipment.gasRateOverride.toString();
    }

    const setting = await this.prisma.client.systemSetting.findFirst({
      where: { id: 'singleton' },
      select: { gasExpenseDeductionRate: true },
    });

    if (!setting) {
      throw new UnprocessableEntityException(
        'The system settings row is missing, so the gas deduction rate cannot be resolved.',
      );
    }

    return setting.gasExpenseDeductionRate.toString();
  }

  private buildChain(shipment: ShipmentWithChain, gasDeductionRate: string): CommissionChain {
    return computeCommissionChain({
      netRate: shipment.netRate.toString(),
      billableExpenses: shipment.billableExpenses.map((line) => ({
        amount: line.amount.toString(),
        isCommissionable: line.isCommissionable,
      })),
      additionalCharges: shipment.additionalCharges.map((line) => ({
        amount: line.amount.toString(),
        isCommissionable: line.isCommissionable,
      })),
      gasDeductionRate,
    });
  }

  private assignedSlots(shipment: ShipmentWithChain): SlotAssignment[] {
    const slots: SlotAssignment[] = [];

    if (shipment.driverId) slots.push({ role: CrewRole.DRIVER, crewMemberId: shipment.driverId });
    if (shipment.helperId) slots.push({ role: CrewRole.HELPER, crewMemberId: shipment.helperId });

    return slots;
  }

  /**
   * The date the rule window is tested against.
   *
   * Dispatch, not delivery: the rate is the one that was in force when the
   * trip was agreed and the crew set off, which is what they were told they
   * would earn. A rule changed mid-journey does not retroactively re-price
   * work already underway. `createdAt` only backstops a shipment that somehow
   * reached computation without a dispatch timestamp.
   */
  private effectiveDate(shipment: ShipmentWithChain): Date {
    return shipment.dispatchedAt ?? shipment.createdAt;
  }

  private async computeSlots(
    shipment: ShipmentWithChain,
    chain: CommissionChain,
    gasDeductionRate: string,
    slots: readonly SlotAssignment[],
  ) {
    const candidates = await this.loadRuleCandidates(shipment);
    const scope = {
      clientId: shipment.clientId,
      routeId: shipment.routeId,
      on: this.effectiveDate(shipment),
    };

    return slots.map((slot) => {
      try {
        const rule = resolveCommissionRule(candidates, slot.role, scope);

        const result = runCommissionStrategy({
          role: slot.role,
          rule: toStrategyRule(rule),
          chain,
          grossRate: shipment.grossRate.toString(),
          tpcAmount: shipment.tpcAmount.toString(),
          netRate: shipment.netRate.toString(),
          gasDeductionRate,
          shipmentRouteId: shipment.routeId,
        });

        return { ...slot, rule: toStrategyRule(rule), result };
      } catch (error) {
        if (error instanceof CommissionComputationError) {
          // 422 rather than 400: the request was well formed, the system state
          // is what makes it unprocessable.
          throw new UnprocessableEntityException(error.message);
        }

        throw error;
      }
    });
  }

  /**
   * Every rule that could possibly apply, narrowed in SQL to the cheap
   * predicates. Precedence is decided in `rule-resolver`, in one readable
   * place, rather than as an ORDER BY nobody can review.
   */
  private async loadRuleCandidates(shipment: ShipmentWithChain) {
    return this.prisma.client.commissionRule.findMany({
      where: {
        isActive: true,
        OR: [{ clientId: null }, { clientId: shipment.clientId }],
        AND: [
          shipment.routeId === null
            ? { routeId: null }
            : { OR: [{ routeId: null }, { routeId: shipment.routeId }] },
        ],
      },
    });
  }

  /**
   * Computing is one of the two conditions for LIQUIDATED; an approved
   * liquidation is the other. Whichever lands second applies the move, so this
   * side checks for the liquidation.
   *
   * The rule itself lives in `@eztruckr/types` and the liquidation service
   * calls the same function from the other side. Two copies of a symmetric
   * predicate is how the two sides end up disagreeing about what "liquidated"
   * means; there is one.
   */
  private statusAfterComputing(shipment: ShipmentWithChain): ShipmentStatus | null {
    if (!isShipmentStatusCode(shipment.status)) {
      throw new UnprocessableEntityException(`Shipment ${shipment.id} has an unrecognised status.`);
    }

    return shipmentStatusAfterLiquidationMilestone(shipment.status, {
      liquidationApproved: shipment.liquidations.some(
        (liquidation) => liquidation.status === LiquidationStatus.APPROVED,
      ),
      // This is the computation that makes it true, so it is true by the time
      // the caller applies the result.
      commissionsComputed: true,
    });
  }
}

export function isShipmentStatusCode(value: number): value is ShipmentStatus {
  return (Object.values(ShipmentStatus) as number[]).includes(value);
}

function toStrategyRule(rule: {
  id: string;
  name: string;
  method: number;
  rate: Prisma.Decimal | null;
  fixedAmount: Prisma.Decimal | null;
  routeId: string | null;
  params: Prisma.JsonValue;
}): StrategyRule {
  if (!isCommissionMethod(rule.method)) {
    throw new CommissionComputationError(
      `Rule "${rule.name}" has an unrecognised commission method (${rule.method}).`,
    );
  }

  return {
    id: rule.id,
    name: rule.name,
    method: rule.method,
    rate: rule.rate?.toString() ?? null,
    fixedAmount: rule.fixedAmount?.toString() ?? null,
    routeId: rule.routeId,
    params: rule.params,
  };
}

type CommissionRow = Prisma.CommissionGetPayload<{
  include: { crewMember: { select: { firstName: true; lastName: true } } };
}>;

export function toCommissionResponse(
  row: CommissionRow,
  shipmentNumber: string | null,
): CommissionResponse {
  if (!isCrewRole(row.role) || !isCommissionMethod(row.appliedMethod)) {
    // Both columns carry CHECK constraints, so this needs raw SQL to reach.
    // Failing loudly beats returning a commission nobody can interpret.
    throw new Error(`Commission ${row.id} has an unrecognised role or method code`);
  }

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    shipmentNumber,
    crewMemberId: row.crewMemberId,
    crewMemberName: `${row.crewMember.firstName} ${row.crewMember.lastName}`,
    role: row.role,
    appliedMethod: row.appliedMethod,
    appliedRuleId: row.appliedRuleId,
    appliedRuleName: row.appliedRuleName,
    commissionableBase: row.commissionableBase.toString(),
    appliedRate: row.appliedRate?.toString() ?? null,
    amount: row.amount.toString(),
    appliedFormulaExpression: row.appliedFormulaExpression,
    appliedFormulaFields: (row.appliedFormulaFields as Record<string, string> | null) ?? null,
    computedAt: row.computedAt.toISOString(),
    payoutLineId: row.payoutLineId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}
