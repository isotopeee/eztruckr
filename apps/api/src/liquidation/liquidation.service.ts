import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  isAllowedLiquidationTransition,
  isCostRecognised,
  isLiquidationEditable,
  isLiquidationHistoryAction,
  isLiquidationStatus,
  isShipmentStatus,
  LIQUIDATION_STATUS_LABELS,
  LiquidationHistoryAction,
  LiquidationStatus,
  money,
  SettlementStatus,
  ShipmentStatus,
  shipmentStatusAfterLiquidationMilestone,
  sum,
  toDecimalString,
  UserRole,
  wasReturnedForCorrection,
  type ApproveLiquidationInput,
  type CreateLiquidationLineInput,
  type Liquidation,
  type LiquidationLine,
  type LiquidationListQuery,
  type ReturnLiquidationInput,
  type ReverseLiquidationInput,
  type SubmitLiquidationInput,
  type UpdateLiquidationLineInput,
} from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from './receipts.service';

/**
 * The liquidation lifecycle: PENDING -> SUBMITTED -> APPROVED, plus the two
 * reasoned moves backwards.
 *
 * THE COSTS ARE NOT POSTED ANYWHERE. "Costs post to the P&L on APPROVED" is
 * implemented as `recognisedCost`, derived from the status every time it is
 * asked for. That is what makes the brief's hardest requirement true by
 * construction rather than by care: return -> resubmit -> approve cannot post
 * two sets of costs, because nothing is ever posted — there is one live
 * liquidation per shipment and it either is approved or is not. A `posted`
 * flag, or ledger rows written on approval, would be a second copy of that fact
 * and would need a compensating entry on every reversal to stay honest.
 *
 * WHAT LOCKS WHEN. Approval is the lock for the liquidation's own contents.
 * Everything else in this codebase locks on `paid` instead, and the difference
 * is not an inconsistency: paid guards figures a payout voucher depends on, and
 * a liquidation line feeds no commission — actual fuel is recognised here and
 * deliberately not in the commission chain. What approval's lock does guard is
 * the variance, which is why reversing it is refused once the settlement has
 * actually moved.
 */

const LIQUIDATION_INCLUDE = {
  shipment: {
    select: {
      shipmentNumber: true,
      status: true,
      driverId: true,
      helperId: true,
      // The second half of the LIQUIDATED predicate. Carried on every read so
      // approval and reversal both decide the shipment's status from the same
      // two facts rather than re-querying one of them.
      commissionsComputedAt: true,
    },
  },
  approvedByUser: { select: { name: true } },
  lines: {
    include: {
      expenseCategory: { select: { name: true, requiresReceipt: true } },
      receipt: { select: { fileName: true } },
    },
    orderBy: { spentAt: 'asc' },
  },
  history: {
    include: { actor: { select: { name: true } } },
    orderBy: { occurredAt: 'asc' },
  },
} satisfies Prisma.LiquidationInclude;

type LiquidationRow = Prisma.LiquidationGetPayload<{ include: typeof LIQUIDATION_INCLUDE }>;
type LineRow = LiquidationRow['lines'][number];

const AUDIT_ENTITY_TYPE = 'Liquidation';
const REVERSAL_ACTION = 'liquidation.reverse-approval';

@Injectable()
export class LiquidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: ReceiptsService,
  ) {}

  // --- reads ---------------------------------------------------------------

  async getForShipment(shipmentId: string): Promise<Liquidation> {
    return toLiquidation(await this.load(shipmentId));
  }

  /**
   * The cross-shipment list: accounting's queue, or one crew member's own.
   *
   * `returnedOnly` is PENDING with prior history, exactly as the code set
   * promises. There is no status to filter on, because a `RETURNED` state would
   * behave identically to PENDING in every other query; this is the one that
   * needs to tell them apart, and the history table is what tells it.
   *
   * `crewMemberId` is passed by the controller from the session, never from the
   * query string, and when it is set it OVERWRITES rather than narrows — there
   * is no parameter a crew login can send to widen its own list.
   */
  async list(query: LiquidationListQuery, crewMemberId: string | null): Promise<Liquidation[]> {
    const rows = await this.prisma.client.liquidation.findMany({
      where: {
        ...(query.returnedOnly
          ? { status: LiquidationStatus.PENDING, history: { some: {} } }
          : query.status === undefined
            ? {}
            : { status: query.status }),
        ...(crewMemberId
          ? { shipment: { OR: [{ driverId: crewMemberId }, { helperId: crewMemberId }] } }
          : {}),
      },
      include: LIQUIDATION_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });

    return rows.map(toLiquidation);
  }

  // --- lines ---------------------------------------------------------------

  async addLine(
    shipmentId: string,
    input: CreateLiquidationLineInput,
    user: RequestUser,
  ): Promise<LiquidationLine> {
    const liquidation = await this.loadEditable(shipmentId, user);

    await this.receipts.assertExists(input.receiptId);

    const row = await this.prisma.client.liquidationLine.create({
      data: {
        liquidationId: liquidation.id,
        expenseCategoryId: input.expenseCategoryId,
        description: input.description,
        amount: input.amount,
        spentAt: new Date(input.spentAt),
        receiptId: input.receiptId,
      },
      include: {
        expenseCategory: { select: { name: true, requiresReceipt: true } },
        receipt: { select: { fileName: true } },
      },
    });

    await this.refreshTotals(shipmentId);

    return toLine(row);
  }

  async updateLine(
    shipmentId: string,
    lineId: string,
    input: UpdateLiquidationLineInput,
    user: RequestUser,
  ): Promise<LiquidationLine> {
    const liquidation = await this.loadEditable(shipmentId, user);

    await this.assertLineBelongs(liquidation.id, lineId);
    await this.receipts.assertExists(input.receiptId);

    const row = await this.prisma.client.liquidationLine.update({
      where: { id: lineId },
      data: {
        ...(input.expenseCategoryId === undefined
          ? {}
          : { expenseCategoryId: input.expenseCategoryId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.spentAt === undefined ? {} : { spentAt: new Date(input.spentAt) }),
        ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
      },
      include: {
        expenseCategory: { select: { name: true, requiresReceipt: true } },
        receipt: { select: { fileName: true } },
      },
    });

    await this.refreshTotals(shipmentId);

    return toLine(row);
  }

  async removeLine(
    shipmentId: string,
    lineId: string,
    user: RequestUser,
  ): Promise<{ removed: true }> {
    const liquidation = await this.loadEditable(shipmentId, user);

    await this.assertLineBelongs(liquidation.id, lineId);

    await this.prisma.client.liquidationLine.softDelete({ id: lineId });
    await this.refreshTotals(shipmentId);

    return { removed: true };
  }

  // --- the four moves ------------------------------------------------------

  /**
   * The crew asserting these are their figures.
   *
   * Office roles may submit on their behalf — crews call the numbers in from
   * the road as often as they type them — and the history row names whoever
   * actually did it, so nothing is disguised.
   */
  async submit(
    shipmentId: string,
    input: SubmitLiquidationInput,
    user: RequestUser,
  ): Promise<Liquidation> {
    const current = await this.load(shipmentId);

    this.assertMove(current, LiquidationStatus.SUBMITTED);
    this.assertCrewOwnsTrip(current, user);

    const totals = await this.computeTotals(shipmentId, current.id);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.liquidation.update({
        where: { id: current.id },
        data: {
          ...totals,
          status: LiquidationStatus.SUBMITTED,
          submittedAt: new Date(),
          ...(input.remarks === null ? {} : { remarks: input.remarks }),
        },
      });

      await tx.liquidationHistory.create({
        data: {
          liquidationId: current.id,
          action: LiquidationHistoryAction.SUBMITTED,
          actorId: user.id,
        },
      });
    });

    return this.getForShipment(shipmentId);
  }

  /**
   * Sending it back, with the reason that makes it actionable.
   *
   * The status returns to PENDING, which already means "with the crew". What
   * makes this distinguishable from never having been submitted is the history
   * row, not a status of its own.
   */
  async returnToCrew(
    shipmentId: string,
    input: ReturnLiquidationInput,
    user: RequestUser,
  ): Promise<Liquidation> {
    const current = await this.load(shipmentId);

    this.assertMove(current, LiquidationStatus.PENDING);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.liquidation.update({
        where: { id: current.id },
        data: { status: LiquidationStatus.PENDING },
      });

      await tx.liquidationHistory.create({
        data: {
          liquidationId: current.id,
          action: LiquidationHistoryAction.RETURNED,
          actorId: user.id,
          reason: input.reason,
        },
      });
    });

    return this.getForShipment(shipmentId);
  }

  /**
   * Approval: the costs become real, the variance is frozen into a settlement,
   * and the shipment may become LIQUIDATED.
   *
   * All three land in one transaction. An approved liquidation with no
   * settlement row would be a trip whose leftover cash has no record at all,
   * and the outstanding-allowances alert reads that row directly.
   */
  async approve(
    shipmentId: string,
    input: ApproveLiquidationInput,
    user: RequestUser,
  ): Promise<Liquidation> {
    const current = await this.load(shipmentId);

    this.assertMove(current, LiquidationStatus.APPROVED);

    const totals = await this.computeTotals(shipmentId, current.id);
    const variance = totals.variance;
    const advanceTo = this.shipmentStatusAfterApproval(current, true);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.liquidation.update({
        where: { id: current.id },
        data: {
          ...totals,
          status: LiquidationStatus.APPROVED,
          approvedAt: new Date(),
          approvedBy: user.id,
          ...(input.remarks === null ? {} : { remarks: input.remarks }),
        },
      });

      // A zero variance is settled on the spot: there is no movement to record,
      // and leaving it OUTSTANDING would put a trip on the alert list that
      // nobody can ever clear. Compared as integer centavos, never as a float.
      const nothingToMove = money(variance).intValue === 0;

      await tx.settlement.create({
        data: {
          shipmentId,
          amount: variance,
          status: nothingToMove ? SettlementStatus.SETTLED : SettlementStatus.OUTSTANDING,
          ...(nothingToMove ? { settledAt: new Date(), settledBy: user.id } : {}),
        },
      });

      if (advanceTo !== null) {
        await tx.shipment.update({ where: { id: shipmentId }, data: { status: advanceTo } });
      }
    });

    return this.getForShipment(shipmentId);
  }

  /**
   * Undoing an approval, with a reason, into the audit trail.
   *
   * Refused once the money has moved. Everything else in this lifecycle can be
   * argued back and forth on paper; a settlement that has been paid out or
   * partly recovered from a payout run cannot, and unlocking the figures behind
   * it would leave the cash trail and the ledger disagreeing.
   */
  async reverse(
    shipmentId: string,
    input: ReverseLiquidationInput,
    user: RequestUser,
    origin: { ipAddress: string | null; userAgent: string | null },
  ): Promise<Liquidation> {
    const current = await this.load(shipmentId);

    this.assertMove(current, LiquidationStatus.SUBMITTED);

    if (current.shipment.status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${current.shipment.shipmentNumber} is closed. Its liquidation can no longer be reversed, because everything downstream of the approval has been settled.`,
      );
    }

    const settlement = await this.settlementToUnwind(shipmentId);
    const revertTo = this.shipmentStatusAfterApproval(current, false);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.liquidation.update({
        where: { id: current.id },
        data: {
          status: LiquidationStatus.SUBMITTED,
          // Cleared, not kept: a row sitting at SUBMITTED while naming an
          // approver is a claim the audit trail then has to argue with. That
          // it WAS approved is recorded below, where it cannot be edited.
          approvedAt: null,
          approvedBy: null,
        },
      });

      if (settlement) {
        await tx.settlement.softDelete({ id: settlement.id });

        // The debt was created by the carry and nothing has been recovered
        // against it, so it goes with the settlement rather than becoming a
        // free-floating deduction nobody can explain.
        if (settlement.crewDeductionId !== null) {
          await tx.crewDeduction.softDelete({ id: settlement.crewDeductionId });
        }
      }

      if (revertTo !== null) {
        await tx.shipment.update({ where: { id: shipmentId }, data: { status: revertTo } });
      }

      await tx.auditLog.create({
        data: {
          actorId: user.id,
          action: REVERSAL_ACTION,
          entityType: AUDIT_ENTITY_TYPE,
          entityId: current.id,
          before: {
            status: String(LiquidationStatus.APPROVED),
            approvedAt: current.approvedAt?.toISOString() ?? '',
            approvedBy: current.approvedBy ?? '',
            totalLiquidated: current.totalLiquidated.toString(),
            variance: current.variance.toString(),
          },
          after: { status: String(LiquidationStatus.SUBMITTED), reason: input.reason },
          ipAddress: origin.ipAddress,
          userAgent: origin.userAgent,
        },
      });
    });

    return this.getForShipment(shipmentId);
  }

  // --- shared internals ----------------------------------------------------

  /**
   * Keeps the stored totals in step with the rows underneath them while the
   * liquidation is open.
   *
   * They are stored because approval freezes them; they are recomputed until
   * then because a stored number that nothing refreshes is the same defect as
   * the cached `recovered` column that was removed from `CrewDeduction`.
   */
  async refreshTotals(shipmentId: string): Promise<void> {
    const liquidation = await this.prisma.client.liquidation.findFirst({
      where: { shipmentId },
      select: { id: true, status: true },
    });

    if (!liquidation || liquidation.status === LiquidationStatus.APPROVED) {
      return;
    }

    const totals = await this.computeTotals(shipmentId, liquidation.id);

    await this.prisma.client.liquidation.update({ where: { id: liquidation.id }, data: totals });
  }

  /** True when this shipment's live liquidation is approved. */
  async isApproved(shipmentId: string): Promise<boolean> {
    const count = await this.prisma.client.liquidation.count({
      where: { shipmentId, status: LiquidationStatus.APPROVED },
    });

    return count > 0;
  }

  private async load(shipmentId: string): Promise<LiquidationRow> {
    const row = await this.prisma.client.liquidation.findFirst({
      where: { shipmentId },
      include: LIQUIDATION_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException(
        `Shipment ${shipmentId} has no liquidation. One is created when the trip is marked delivered.`,
      );
    }

    return row;
  }

  private async loadEditable(shipmentId: string, user: RequestUser): Promise<LiquidationRow> {
    const row = await this.load(shipmentId);
    const status = statusOf(row);

    if (!isLiquidationEditable(status)) {
      throw new ConflictException(
        `The liquidation for shipment ${row.shipment.shipmentNumber} is approved and locked. Reverse the approval, with a reason, to change it.`,
      );
    }

    this.assertCrewOwnsTrip(row, user);

    return row;
  }

  /**
   * Totals from the live rows: every allowance released on the trip, every line
   * claimed against it.
   *
   * `totalAllowance` sums ALL the allowances. Measuring a variance against one
   * release would report a crew member as owing money they were separately
   * advanced for.
   */
  private async computeTotals(shipmentId: string, liquidationId: string) {
    const [allowances, lines] = await Promise.all([
      this.prisma.client.allowance.findMany({ where: { shipmentId }, select: { amount: true } }),
      this.prisma.client.liquidationLine.findMany({
        where: { liquidationId },
        select: { amount: true },
      }),
    ]);

    const totalAllowance = sum(allowances.map((row) => row.amount));
    const totalLiquidated = sum(lines.map((row) => row.amount));

    return {
      totalAllowance: toDecimalString(totalAllowance),
      totalLiquidated: toDecimalString(totalLiquidated),
      variance: toDecimalString(totalAllowance.subtract(totalLiquidated)),
    };
  }

  private assertMove(row: LiquidationRow, to: LiquidationStatus): void {
    const from = statusOf(row);

    if (!isAllowedLiquidationTransition(from, to)) {
      throw new ConflictException(
        `A ${LIQUIDATION_STATUS_LABELS[from].toLowerCase()} liquidation cannot move to ${LIQUIDATION_STATUS_LABELS[to].toLowerCase()}.`,
      );
    }
  }

  /**
   * A crew session may only touch the liquidation of a trip it worked.
   *
   * Checked here rather than only in the controller because the crew portal and
   * the office screens reach the same methods, and the scope is a property of
   * the record, not of the route.
   */
  private assertCrewOwnsTrip(row: LiquidationRow, user: RequestUser): void {
    if (user.role !== UserRole.CREW) return;

    if (!user.crewMemberId) {
      throw new ForbiddenException('This crew account is not linked to a crew member.');
    }

    const worked =
      row.shipment.driverId === user.crewMemberId || row.shipment.helperId === user.crewMemberId;

    if (!worked) {
      throw new ForbiddenException('You can only liquidate trips you worked on.');
    }
  }

  /** The shipment status implied by an approval landing or being retracted. */
  private shipmentStatusAfterApproval(
    row: LiquidationRow,
    approved: boolean,
  ): ShipmentStatus | null {
    if (!isShipmentStatus(row.shipment.status)) {
      throw new Error(`Shipment ${row.shipmentId} has an unrecognised status code.`);
    }

    return shipmentStatusAfterLiquidationMilestone(row.shipment.status, {
      liquidationApproved: approved,
      commissionsComputed: row.shipment.commissionsComputedAt !== null,
    });
  }

  /**
   * The settlement a reversal would have to undo, or a refusal.
   *
   * Unwinding is only safe while nothing has moved: an OUTSTANDING settlement
   * is a statement of intent, and a carry whose deduction has recovered nothing
   * is the same. Anything else is cash that has changed hands.
   */
  private async settlementToUnwind(shipmentId: string) {
    const settlement = await this.prisma.client.settlement.findFirst({
      where: { shipmentId },
      select: { id: true, status: true, amount: true, crewDeductionId: true },
    });

    if (!settlement) return null;

    if (settlement.status === SettlementStatus.SETTLED && !settlement.amount.isZero()) {
      throw new ConflictException(
        `The variance on this trip has already been settled. Reverse the settlement first — the approval cannot be undone while the cash movement behind it stands.`,
      );
    }

    if (settlement.crewDeductionId !== null) {
      const recovered = await this.prisma.client.crewDeductionRecovery.count({
        where: { crewDeductionId: settlement.crewDeductionId },
      });

      if (recovered > 0) {
        throw new ConflictException(
          `This trip's variance is being recovered from the crew's pay and ${recovered} slice(s) have already been taken. The approval can no longer be reversed.`,
        );
      }
    }

    return settlement;
  }

  private async assertLineBelongs(liquidationId: string, lineId: string): Promise<void> {
    const found = await this.prisma.client.liquidationLine.findFirst({
      where: { id: lineId, liquidationId },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException(`No liquidation line ${lineId} on this liquidation`);
    }
  }
}

function statusOf(row: { id: string; status: number }): LiquidationStatus {
  if (!isLiquidationStatus(row.status)) {
    throw new Error(`Liquidation ${row.id} has an unrecognised status code ${row.status}`);
  }

  return row.status;
}

function toLine(row: LineRow): LiquidationLine {
  return {
    id: row.id,
    liquidationId: row.liquidationId,
    expenseCategoryId: row.expenseCategoryId,
    expenseCategoryName: row.expenseCategory?.name ?? null,
    description: row.description,
    amount: row.amount.toString(),
    spentAt: row.spentAt.toISOString(),
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    requiresReceipt: row.expenseCategory?.requiresReceipt ?? false,
    ...auditFields(row),
  };
}

export function toLiquidation(row: LiquidationRow): Liquidation {
  const status = statusOf(row);

  const history = row.history.map((entry) => {
    if (!isLiquidationHistoryAction(entry.action)) {
      throw new Error(`Liquidation history ${entry.id} has an unrecognised action code`);
    }

    return {
      id: entry.id,
      action: entry.action,
      actorId: entry.actorId,
      actorName: entry.actor?.name ?? null,
      occurredAt: entry.occurredAt.toISOString(),
      reason: entry.reason,
    };
  });

  const latestReturn = [...history]
    .reverse()
    .find((entry) => entry.action === LiquidationHistoryAction.RETURNED);

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment?.shipmentNumber ?? null,

    status,

    totalAllowance: row.totalAllowance.toString(),
    totalLiquidated: row.totalLiquidated.toString(),
    variance: row.variance.toString(),

    submittedAt: dateToIso(row.submittedAt),
    approvedAt: dateToIso(row.approvedAt),
    approvedBy: row.approvedBy,
    approvedByName: row.approvedByUser?.name ?? null,
    remarks: row.remarks,

    lines: row.lines.map(toLine),
    history,

    // Derived, never stored. See the class docblock: this is what stops a
    // return-and-resubmit cycle posting a second set of costs.
    recognisedCost: isCostRecognised(status) ? row.totalLiquidated.toString() : '0.00',

    wasReturned: wasReturnedForCorrection(status, history.length),
    latestReturnReason: latestReturn?.reason ?? null,

    isEditable: isLiquidationEditable(status),

    ...auditFields(row),
  };
}
