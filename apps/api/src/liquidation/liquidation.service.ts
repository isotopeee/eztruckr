import {
  BadRequestException,
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
  type CreateLiquidationInput,
  type CreateLiquidationLineInput,
  type Liquidation,
  type LiquidationLine,
  type LiquidationListQuery,
  type ReturnLiquidationInput,
  type ReverseLiquidationInput,
  type SetCustodianInput,
  type SubmitLiquidationInput,
  type UpdateLiquidationLineInput,
} from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { assertMayHoldTripCash } from './trip-cash-participants';
import { ReceiptsService } from './receipts.service';

/**
 * The liquidation lifecycle: PENDING -> SUBMITTED -> APPROVED, plus the two
 * reasoned moves backwards.
 *
 * THE COSTS ARE NOT POSTED ANYWHERE. "Costs post to the P&L on APPROVED" is
 * implemented as `recognisedCost`, derived from the status every time it is
 * asked for. That is what makes the brief's hardest requirement true by
 * construction rather than by care: return -> resubmit -> approve cannot post
 * two sets of costs, because nothing is ever posted — a liquidation either is
 * approved or is not. A `posted`
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
 *
 * ONE ACCOUNT PER CUSTODIAN. Every method here is keyed on a LIQUIDATION id,
 * not a shipment id, and that is the whole shape of this change: a trip can
 * carry several accounts and approving the driver's must not touch, freeze or
 * speak for the helper's. The only place the trip is consulted as a whole is
 * the shipment's own status, which needs EVERY account settled before the trip
 * can be called liquidated.
 */

/** Exported alongside `toLiquidation`, which cannot be called without it. */
export const LIQUIDATION_INCLUDE = {
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
  custodian: { select: { firstName: true, lastName: true } },
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

  async get(liquidationId: string): Promise<Liquidation> {
    return toLiquidation(await this.load(liquidationId));
  }

  /**
   * Every account on one trip, oldest first.
   *
   * A list where there used to be a single record. The trip's own liquidation —
   * the one created with the shipment, before anybody was assigned — leads,
   * because it is the one a release lands on when nobody has chosen otherwise.
   */
  async listForShipment(shipmentId: string): Promise<Liquidation[]> {
    const rows = await this.prisma.client.liquidation.findMany({
      where: { shipmentId },
      include: LIQUIDATION_INCLUDE,
      orderBy: [{ createdAt: 'asc' }],
    });

    return rows.map(toLiquidation);
  }

  /**
   * The cross-shipment list: accounting's queue, or one crew member's own.
   *
   * `returnedOnly` is PENDING with prior history, exactly as the code set
   * promises. There is no status to filter on, because a `RETURNED` state would
   * behave identically to PENDING in every other query; this is the one that
   * needs to tell them apart, and the history table is what tells it.
   *
   * `staffId` is passed by the controller from the session, never from the
   * query string, and when it is set it OVERWRITES rather than narrows — there
   * is no parameter a crew login can send to widen its own list.
   *
   * THE CREW SCOPE IS CUSTODIANSHIP, NOT THE TRIP, and it mirrors
   * `assertCrewMayAccount` deliberately. "Trips you worked" was the same thing
   * while a trip held one account; now it is wider than what the crew member
   * may actually do, and this list is titled "waiting on you" — it would have
   * told a helper the driver's ₱10,000 was theirs to explain, offered them a
   * row, and had the write refused. A list that disagrees with the guard behind
   * it is a list that lies. The unassigned account is included for anyone who
   * worked the trip, for the same reason the guard admits them: it is the row
   * created at booking, and nobody has been named to it yet.
   *
   * DRAFTS ARE EXCLUDED, unconditionally. A liquidation now exists from the
   * moment a trip is booked, so PENDING on its own has stopped meaning "the
   * crew owe us paperwork" — a draft has nothing to account for, and without
   * this every unbooked trip would sit in accounting's queue and in the crew
   * portal's. The row is still reachable through the shipment; what this list
   * is, is a work queue, and work that has not started is not on it.
   */
  async list(query: LiquidationListQuery, staffId: string | null): Promise<Liquidation[]> {
    const rows = await this.prisma.client.liquidation.findMany({
      where: {
        ...(query.returnedOnly
          ? { status: LiquidationStatus.PENDING, history: { some: {} } }
          : query.status === undefined
            ? {}
            : { status: query.status }),
        ...(staffId
          ? {
              OR: [
                { custodianId: staffId },
                {
                  custodianId: null,
                  shipment: {
                    OR: [{ driverId: staffId }, { helperId: staffId }],
                  },
                },
              ],
            }
          : {}),
        shipment: { status: { not: ShipmentStatus.DRAFT } },
      },
      include: LIQUIDATION_INCLUDE,
      orderBy: { updatedAt: 'desc' },
    });

    return rows.map(toLiquidation);
  }

  // --- opening and naming an account ---------------------------------------

  /**
   * Opens a second account on a trip, for a second cash holder.
   *
   * The custodian is required here even though the column is nullable: the
   * nullable case exists for exactly one row — the account created with the
   * shipment — and the partial unique index (NULLS NOT DISTINCT) refuses a
   * second unnamed one anyway. Failing in the service with a sentence beats
   * failing at an index name.
   */
  async createForShipment(shipmentId: string, input: CreateLiquidationInput): Promise<Liquidation> {
    await this.assertMayBeCustodian(shipmentId, input.custodianId);
    await this.assertNoOpenAccountFor(shipmentId, input.custodianId, null);

    const row = await this.prisma.client.liquidation.create({
      data: {
        shipmentId,
        custodianId: input.custodianId,
        status: LiquidationStatus.PENDING,
      },
      include: LIQUIDATION_INCLUDE,
    });

    return toLiquidation(row);
  }

  /**
   * Naming, or renaming, who is answerable.
   *
   * Refused once approved, for the same reason the lines are: the variance has
   * been frozen into a settlement that names this person, and moving the
   * custodian underneath it would leave the settlement chasing somebody who is
   * no longer accountable.
   */
  async setCustodian(liquidationId: string, input: SetCustodianInput): Promise<Liquidation> {
    const current = await this.load(liquidationId);

    if (!isLiquidationEditable(statusOf(current))) {
      throw new ConflictException(
        `${describe(current)} is approved; its custodian is now part of the settled record. Reverse the approval, with a reason, to change it.`,
      );
    }

    if (input.custodianId !== null) {
      await this.assertMayBeCustodian(current.shipmentId, input.custodianId);
      await this.assertNoOpenAccountFor(current.shipmentId, input.custodianId, liquidationId);
    }

    return toLiquidation(
      await this.prisma.client.liquidation.update({
        where: { id: liquidationId },
        data: { custodianId: input.custodianId },
        include: LIQUIDATION_INCLUDE,
      }),
    );
  }

  /**
   * Removing an account somebody opened by mistake.
   *
   * Only while it is empty. A liquidation carrying releases or claims is a
   * record of money that moved, and soft-deleting it would strand both — the
   * composite foreign key would refuse anyway, and an error from an index is a
   * worse way to learn it.
   */
  async remove(liquidationId: string): Promise<{ removed: true }> {
    const current = await this.load(liquidationId);

    if (!isLiquidationEditable(statusOf(current))) {
      throw new ConflictException(`${describe(current)} is approved and can no longer be removed.`);
    }

    const releases = await this.prisma.client.allowance.count({ where: { liquidationId } });

    if (releases > 0 || current.lines.length > 0) {
      throw new ConflictException(
        `${describe(current)} has ${releases} release(s) and ${current.lines.length} claimed expense(s) against it. Move or remove those first.`,
      );
    }

    await this.prisma.client.liquidation.softDelete({ id: liquidationId });

    return { removed: true };
  }

  // --- lines ---------------------------------------------------------------

  async addLine(
    liquidationId: string,
    input: CreateLiquidationLineInput,
    user: RequestUser,
  ): Promise<LiquidationLine> {
    const liquidation = await this.loadEditable(liquidationId, user);

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

    await this.refreshTotals(liquidationId);

    return toLine(row);
  }

  async updateLine(
    liquidationId: string,
    lineId: string,
    input: UpdateLiquidationLineInput,
    user: RequestUser,
  ): Promise<LiquidationLine> {
    const liquidation = await this.loadEditable(liquidationId, user);

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

    await this.refreshTotals(liquidationId);

    return toLine(row);
  }

  async removeLine(
    liquidationId: string,
    lineId: string,
    user: RequestUser,
  ): Promise<{ removed: true }> {
    const liquidation = await this.loadEditable(liquidationId, user);

    await this.assertLineBelongs(liquidation.id, lineId);

    await this.prisma.client.liquidationLine.softDelete({ id: lineId });
    await this.refreshTotals(liquidationId);

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
    liquidationId: string,
    input: SubmitLiquidationInput,
    user: RequestUser,
  ): Promise<Liquidation> {
    const current = await this.load(liquidationId);

    this.assertMove(current, LiquidationStatus.SUBMITTED);
    this.assertCrewMayAccount(current, user);

    const totals = await this.computeTotals(current.id);

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

    return this.get(liquidationId);
  }

  /**
   * Sending it back, with the reason that makes it actionable.
   *
   * The status returns to PENDING, which already means "with the crew". What
   * makes this distinguishable from never having been submitted is the history
   * row, not a status of its own.
   */
  async returnToCrew(
    liquidationId: string,
    input: ReturnLiquidationInput,
    user: RequestUser,
  ): Promise<Liquidation> {
    const current = await this.load(liquidationId);

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

    return this.get(liquidationId);
  }

  /**
   * Approval: the costs become real, the variance is frozen into a settlement,
   * and the shipment may become LIQUIDATED.
   *
   * All three land in one transaction. An approved liquidation with no
   * settlement row would be cash with no record at all, and the
   * outstanding-allowances alert reads that row directly.
   *
   * The shipment only moves when EVERY account on it is approved — approving
   * the driver's while the helper still holds uncounted cash must not call the
   * trip liquidated.
   */
  async approve(
    liquidationId: string,
    input: ApproveLiquidationInput,
    user: RequestUser,
  ): Promise<Liquidation> {
    const current = await this.load(liquidationId);

    this.assertMove(current, LiquidationStatus.APPROVED);

    const totals = await this.computeTotals(current.id);
    const variance = totals.variance;
    const advanceTo = await this.shipmentStatusAfterApproval(current, true);

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
          shipmentId: current.shipmentId,
          // The settlement squares ONE custodian's account. Per shipment, two
          // people each holding change would collide on the live-unique index
          // — and the survivor's figure would be the blend that made the alert
          // unable to name anybody.
          liquidationId: current.id,
          amount: variance,
          status: nothingToMove ? SettlementStatus.SETTLED : SettlementStatus.OUTSTANDING,
          ...(nothingToMove ? { settledAt: new Date(), settledBy: user.id } : {}),
        },
      });

      if (advanceTo !== null) {
        await tx.shipment.update({
          where: { id: current.shipmentId },
          data: { status: advanceTo },
        });
      }
    });

    return this.get(liquidationId);
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
    liquidationId: string,
    input: ReverseLiquidationInput,
    user: RequestUser,
    origin: { ipAddress: string | null; userAgent: string | null },
  ): Promise<Liquidation> {
    const current = await this.load(liquidationId);

    this.assertMove(current, LiquidationStatus.SUBMITTED);

    if (current.shipment.status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${current.shipment.shipmentNumber} is closed. Its liquidation can no longer be reversed, because everything downstream of the approval has been settled.`,
      );
    }

    const settlement = await this.settlementToUnwind(current.id);
    const revertTo = await this.shipmentStatusAfterApproval(current, false);

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
        await tx.shipment.update({
          where: { id: current.shipmentId },
          data: { status: revertTo },
        });
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

    return this.get(liquidationId);
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
  async refreshTotals(liquidationId: string): Promise<void> {
    const liquidation = await this.prisma.client.liquidation.findFirst({
      where: { id: liquidationId },
      select: { id: true, status: true },
    });

    if (!liquidation || liquidation.status === LiquidationStatus.APPROVED) {
      return;
    }

    const totals = await this.computeTotals(liquidation.id);

    await this.prisma.client.liquidation.update({ where: { id: liquidation.id }, data: totals });
  }

  /**
   * True when EVERY account on the shipment is approved.
   *
   * "All", not "any", and the distinction is the reason this method still takes
   * a shipment id while everything else takes a liquidation id: its callers are
   * asking about the TRIP — may it close, may more cash go out — and one
   * custodian squaring up says nothing about the other still holding ₱3,000.
   *
   * A trip with no liquidation at all answers false: there is nothing to say
   * the cash was accounted for, which is the safe direction for a guard.
   */
  async allApproved(shipmentId: string): Promise<boolean> {
    const [total, approved] = await Promise.all([
      this.prisma.client.liquidation.count({ where: { shipmentId } }),
      this.prisma.client.liquidation.count({
        where: { shipmentId, status: LiquidationStatus.APPROVED },
      }),
    ]);

    return total > 0 && total === approved;
  }

  private async load(liquidationId: string): Promise<LiquidationRow> {
    const row = await this.prisma.client.liquidation.findFirst({
      where: { id: liquidationId },
      include: LIQUIDATION_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException(`No liquidation with id ${liquidationId}`);
    }

    return row;
  }

  private async loadEditable(liquidationId: string, user: RequestUser): Promise<LiquidationRow> {
    const row = await this.load(liquidationId);
    const status = statusOf(row);

    if (!isLiquidationEditable(status)) {
      throw new ConflictException(
        `${describe(row)} is approved and locked. Reverse the approval, with a reason, to change it.`,
      );
    }

    this.assertCrewMayAccount(row, user);

    return row;
  }

  /**
   * Totals for ONE account: the releases booked against it, and the lines
   * claimed against it.
   *
   * `totalAllowance` used to sum every allowance on the SHIPMENT, which was
   * correct only while a trip could have one account. With two custodians it
   * charged each of them with the other's advances, so both variances were
   * wrong and their errors cancelled at trip level — the hardest kind to spot.
   */
  private async computeTotals(liquidationId: string) {
    const [allowances, lines] = await Promise.all([
      this.prisma.client.allowance.findMany({ where: { liquidationId }, select: { amount: true } }),
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
   * A crew session may only account for cash it is answerable for.
   *
   * NARROWER THAN IT WAS, deliberately. The old rule was "did you work this
   * trip", which was as tight as a single blended account allowed. Now that
   * each account names a custodian, a helper who worked the trip has no
   * business editing the driver's claims — that is somebody else's money to
   * explain, and the two used to be one row precisely because there was no way
   * to say so.
   *
   * An account with NO custodian yet is open to anyone who worked the trip: it
   * is the one created with the shipment, before anybody was assigned, and
   * refusing everybody would leave it unusable until an office user named
   * somebody.
   *
   * Checked here rather than only in the controller because the crew portal and
   * the office screens reach the same methods, and the scope is a property of
   * the record, not of the route.
   */
  private assertCrewMayAccount(row: LiquidationRow, user: RequestUser): void {
    if (user.role !== UserRole.CREW) return;

    if (!user.staffId) {
      throw new ForbiddenException('This crew account is not linked to a crew member.');
    }

    if (row.custodianId !== null) {
      if (row.custodianId !== user.staffId) {
        throw new ForbiddenException(
          'This cash is another crew member’s to account for. You can only liquidate what you were made custodian of.',
        );
      }

      return;
    }

    const worked = row.shipment.driverId === user.staffId || row.shipment.helperId === user.staffId;

    if (!worked) {
      throw new ForbiddenException('You can only liquidate trips you worked on.');
    }
  }

  /**
   * The shipment status implied by THIS approval landing or being retracted.
   *
   * The trip's half of the question is "are they all approved", so this counts
   * the siblings rather than speaking for them. `approved` says what this one
   * is about to become, because the row has not been written yet — reading the
   * database for it would give the value it is replacing.
   */
  private async shipmentStatusAfterApproval(
    row: LiquidationRow,
    approved: boolean,
  ): Promise<ShipmentStatus | null> {
    if (!isShipmentStatus(row.shipment.status)) {
      throw new Error(`Shipment ${row.shipmentId} has an unrecognised status code.`);
    }

    const othersOutstanding = await this.prisma.client.liquidation.count({
      where: {
        shipmentId: row.shipmentId,
        id: { not: row.id },
        status: { not: LiquidationStatus.APPROVED },
      },
    });

    return shipmentStatusAfterLiquidationMilestone(row.shipment.status, {
      allLiquidationsApproved: approved && othersOutstanding === 0,
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
  private async settlementToUnwind(liquidationId: string) {
    const settlement = await this.prisma.client.settlement.findFirst({
      where: { liquidationId },
      select: { id: true, status: true, amount: true, crewDeductionId: true },
    });

    if (!settlement) return null;

    if (settlement.status === SettlementStatus.SETTLED && !settlement.amount.isZero()) {
      throw new ConflictException(
        `This variance has already been settled. Reverse the settlement first — the approval cannot be undone while the cash movement behind it stands.`,
      );
    }

    if (settlement.crewDeductionId !== null) {
      const recovered = await this.prisma.client.crewDeductionRecovery.count({
        where: { crewDeductionId: settlement.crewDeductionId },
      });

      if (recovered > 0) {
        throw new ConflictException(
          `This variance is being recovered from the crew's pay and ${recovered} slice(s) have already been taken. The approval can no longer be reversed.`,
        );
      }
    }

    return settlement;
  }

  /**
   * A custodian is somebody the trip's cash could actually be in the hands of.
   *
   * The crew who worked it, or a dispatch manager holding its float — see
   * `assertMayHoldTripCash`, which the allowance recipient and the carried
   * deduction ask as well. Not merely an existing staff member: being
   * answerable for a trip's cash with no connection to it is a typo.
   */
  private assertMayBeCustodian(shipmentId: string, custodianId: string): Promise<void> {
    return assertMayHoldTripCash(
      this.prisma,
      shipmentId,
      custodianId,
      'custodianId',
      (shipmentNumber) =>
        `That person neither worked shipment ${shipmentNumber} nor is a dispatch manager, so they cannot be made custodian of its cash.`,
    );
  }

  /**
   * One open account per person per trip.
   *
   * `liquidation_shipment_custodian_live_key` enforces this, and this method
   * exists to say it in a sentence rather than as an index name — a second
   * account for the same person is not a constraint violation to the user, it
   * is a screen they should not have offered.
   */
  private async assertNoOpenAccountFor(
    shipmentId: string,
    custodianId: string,
    excludingId: string | null,
  ): Promise<void> {
    const existing = await this.prisma.client.liquidation.findFirst({
      where: {
        shipmentId,
        custodianId,
        ...(excludingId === null ? {} : { id: { not: excludingId } }),
      },
      include: { custodian: { select: { firstName: true, lastName: true } } },
    });

    if (existing) {
      const name = existing.custodian
        ? `${existing.custodian.firstName} ${existing.custodian.lastName}`
        : 'That crew member';

      throw badRequest(
        'custodianId',
        `${name} already holds an account on this trip. Add the release to it rather than opening a second.`,
      );
    }
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

/**
 * How an account reads in a refusal.
 *
 * A trip can carry several now, so "the liquidation for shipment X" stopped
 * identifying anything — the person is what tells them apart.
 */
function describe(row: LiquidationRow): string {
  const who = row.custodian
    ? `${row.custodian.firstName} ${row.custodian.lastName}'s liquidation`
    : 'The unassigned liquidation';

  return `${who} on shipment ${row.shipment.shipmentNumber}`;
}

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
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

    custodianId: row.custodianId,
    custodianName: row.custodian ? `${row.custodian.firstName} ${row.custodian.lastName}` : null,

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
    //
    // Both branches at 2dp. `Decimal.toString()` drops trailing zeros, so this
    // used to answer "0.00" when unrecognised and "9000" when recognised — one
    // field, two formats, decided by a branch the caller cannot see. Anything
    // comparing the two answers would have been comparing strings that never
    // agree on their own shape.
    recognisedCost: toDecimalString(money(isCostRecognised(status) ? row.totalLiquidated : 0)),

    wasReturned: wasReturnedForCorrection(status, history.length),
    latestReturnReason: latestReturn?.reason ?? null,

    isEditable: isLiquidationEditable(status),

    ...auditFields(row),
  };
}
