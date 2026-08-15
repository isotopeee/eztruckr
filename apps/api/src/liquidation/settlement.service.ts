import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  isAllowanceOutstanding,
  isDisbursementMode,
  isSettlementStatus,
  money,
  PayoutRunStatus,
  SETTLEMENT_STATUS_LABELS,
  SettlementStatus,
  sum,
  toDecimalString,
  type CarrySettlementToPayoutInput,
  type OutstandingAllowanceReport,
  type RecordSettlementInput,
  type Settlement,
} from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptsService } from './receipts.service';
import { assertMayHoldTripCash } from './trip-cash-participants';

/**
 * What happened to the cash left over after a trip was liquidated.
 *
 * THE ALERT READS THIS, NOT THE LIQUIDATION. The two answer different
 * questions, and the difference is the entire reason this record exists: an
 * approved liquidation says the spending was accounted for, and says nothing at
 * all about whether the ₱1,400 the driver had left ever came back. A dashboard
 * that inferred one from the other would report a trip as clear while the crew
 * still held the change.
 *
 * ONE RECORD PER LIQUIDATION, not per shipment. Within one custodian's account
 * there is still no honest way to say which release a returned amount came from,
 * so nothing tries — but ACROSS custodians there is, and pretending otherwise is
 * what the old shape did: two people each holding change shared one row, so the
 * alert could name a trip and never a person, and squaring up was
 * all-or-nothing for both of them.
 */

const SETTLEMENT_INCLUDE = {
  shipment: { select: { shipmentNumber: true } },
  liquidation: {
    select: {
      custodianId: true,
      approvedAt: true,
      custodian: { select: { firstName: true, lastName: true } },
    },
  },
  settledByUser: { select: { name: true } },
  receipt: { select: { fileName: true } },
  crewDeduction: {
    select: { amount: true, recoveries: { select: { amount: true } } },
  },
} satisfies Prisma.SettlementInclude;

type SettlementRow = Prisma.SettlementGetPayload<{ include: typeof SETTLEMENT_INCLUDE }>;

@Injectable()
export class SettlementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: ReceiptsService,
  ) {}

  async getForLiquidation(liquidationId: string): Promise<Settlement> {
    return toSettlement(await this.load(liquidationId));
  }

  /**
   * Every account's settlement on one trip, for the shipment screen.
   *
   * `custodianScope` comes from the session — `accountScopeFor` — and never
   * from the request. Null is every account, which is what an office session
   * gets; a crew session gets their own staff id, and the filter is applied in
   * the QUERY rather than after it, so a settlement that is not theirs is
   * never loaded, let alone serialised.
   */
  async listForShipment(shipmentId: string, custodianScope: string | null): Promise<Settlement[]> {
    const rows = await this.prisma.client.settlement.findMany({
      where: {
        shipmentId,
        ...(custodianScope ? { liquidation: { custodianId: custodianScope } } : {}),
      },
      include: SETTLEMENT_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toSettlement);
  }

  /**
   * Recording that the money actually moved, documented exactly the way the
   * release was: mode, optional reference, optional attachment.
   */
  async record(
    liquidationId: string,
    input: RecordSettlementInput,
    user: RequestUser,
  ): Promise<Settlement> {
    const current = await this.load(liquidationId);

    this.assertOutstanding(current, 'recorded as settled');
    await this.receipts.assertExists(input.receiptId);

    await this.prisma.client.settlement.update({
      where: { id: current.id },
      data: {
        status: SettlementStatus.SETTLED,
        disbursementMode: input.disbursementMode,
        referenceNumber: input.referenceNumber,
        receiptId: input.receiptId,
        settledAt: new Date(),
        settledBy: user.id,
        ...(input.remarks === null ? {} : { remarks: input.remarks }),
      },
    });

    return this.getForLiquidation(liquidationId);
  }

  /**
   * Recovering the balance from the crew's pay instead of in cash.
   *
   * The debt becomes an ordinary `CrewDeduction`. That is not a shortcut: a
   * payout run already recovers deductions in slices, already refuses to
   * over-recover, and already freezes a recovery once its run is PAID. A
   * parallel mechanism here would be a second, weaker copy of all three.
   *
   * ONE DIRECTION ONLY. A negative variance is money the company owes the crew,
   * and a payout run has nothing to recover from it. Handing that over is a
   * cash movement, which is what `record` is for.
   */
  async carryToPayout(
    liquidationId: string,
    input: CarrySettlementToPayoutInput,
  ): Promise<Settlement> {
    const current = await this.load(liquidationId);

    this.assertOutstanding(current, 'carried to payout');

    if (current.amount.lessThanOrEqualTo(0)) {
      throw new ConflictException(
        `This variance is ${current.amount.toString()}, which is money owed to the crew rather than by them. A payout run has nothing to recover — hand it over and record the movement instead.`,
      );
    }

    await this.assertMayBeCharged(current.shipmentId, input.staffId);

    // Names the custodian as well as the trip. A deduction reading only
    // "shipment 20260813001" was unambiguous while a trip had one account; with
    // two it would sit on a payslip without saying which cash it was for.
    const custodian = current.liquidation?.custodian;
    const whose = custodian ? ` held by ${custodian.firstName} ${custodian.lastName}` : '';

    const reason =
      input.reason ??
      `Unliquidated allowance${whose} on shipment ${current.shipment?.shipmentNumber ?? current.shipmentId}`;

    await this.prisma.client.$transaction(async (tx) => {
      const deduction = await tx.crewDeduction.create({
        data: {
          staffId: input.staffId,
          shipmentId: current.shipmentId,
          reason,
          amount: current.amount,
        },
        select: { id: true },
      });

      await tx.settlement.update({
        where: { id: current.id },
        data: {
          status: SettlementStatus.CARRIED_TO_PAYOUT,
          crewDeductionId: deduction.id,
          ...(input.reason === null ? {} : { remarks: input.reason }),
        },
      });
    });

    // Deliberately not settled here. The money has not moved yet, so the trip
    // stays on the outstanding list until the run that recovers it is paid.
    return this.getForLiquidation(liquidationId);
  }

  /**
   * Clears carried settlements whose debt has been fully recovered by runs that
   * were actually paid.
   *
   * PHASE 6 CALLS THIS when it marks a payout run Paid — that is the event this
   * describes, and there is no other. It is written here, with the settlement
   * rules, rather than left for the payout code to reinvent against a status it
   * does not own. Recoveries attached to a DRAFT or APPROVED run do not count:
   * money that has not left is not recovery.
   */
  async clearRecoveredCarryovers(actorId: string): Promise<{ cleared: string[] }> {
    const carried = await this.prisma.client.settlement.findMany({
      where: { status: SettlementStatus.CARRIED_TO_PAYOUT },
      select: {
        id: true,
        amount: true,
        crewDeduction: {
          select: {
            recoveries: {
              where: { payoutLine: { payoutRun: { status: PayoutRunStatus.PAID } } },
              select: { amount: true },
            },
          },
        },
      },
    });

    const cleared: string[] = [];

    for (const settlement of carried) {
      const recovered = sum(settlement.crewDeduction?.recoveries.map((row) => row.amount) ?? []);

      // Integer centavos, so a debt is never left a rounding error short of
      // clear — or declared clear a rounding error early.
      if (money(recovered).intValue < money(settlement.amount).intValue) {
        continue;
      }

      await this.prisma.client.settlement.update({
        where: { id: settlement.id },
        data: {
          status: SettlementStatus.SETTLED,
          settledAt: new Date(),
          settledBy: actorId,
          // No disbursement mode, and that is the honest answer: this balance
          // never moved as cash. It was netted off the crew member's pay, and
          // `crewDeductionId` says which debt did it.
          // `settlement_movement_matches_status` allows exactly this case.
        },
      });

      cleared.push(settlement.id);
    }

    return { cleared };
  }

  /**
   * The "allowances outstanding" alert.
   *
   * Reads `settlement.status` and nothing else. CARRIED_TO_PAYOUT stays on the
   * list, because the decision has been made and the money has not moved.
   */
  async outstanding(): Promise<OutstandingAllowanceReport> {
    const rows = await this.prisma.client.settlement.findMany({
      where: { status: { in: [SettlementStatus.OUTSTANDING, SettlementStatus.CARRIED_TO_PAYOUT] } },
      include: {
        shipment: { select: { shipmentNumber: true } },
        liquidation: {
          select: {
            approvedAt: true,
            custodian: { select: { firstName: true, lastName: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const items = rows.map((row) => {
      if (!isSettlementStatus(row.status)) {
        throw new Error(`Settlement ${row.id} has an unrecognised status code ${row.status}`);
      }

      // Read straight off THIS settlement's own liquidation. It used to walk
      // the shipment's liquidations and assert there was exactly one live
      // row — correct while a trip could only have one account, and the very
      // assumption this change removes. The alert can now name the person
      // holding the cash rather than just the trip it went out on.
      return {
        shipmentId: row.shipmentId,
        shipmentNumber: row.shipment?.shipmentNumber ?? row.shipmentId,
        liquidationId: row.liquidationId,
        custodianName: row.liquidation?.custodian
          ? `${row.liquidation.custodian.firstName} ${row.liquidation.custodian.lastName}`
          : null,
        status: row.status,
        amount: row.amount.toString(),
        approvedAt: dateToIso(row.liquidation?.approvedAt ?? null),
      };
    });

    return {
      items,
      total: items.length,
      totalAmount: toDecimalString(sum(items.map((item) => item.amount))),
    };
  }

  // -------------------------------------------------------------------------

  private assertOutstanding(row: SettlementRow, action: string): void {
    if (!isSettlementStatus(row.status)) {
      throw new Error(`Settlement ${row.id} has an unrecognised status code ${row.status}`);
    }

    if (row.status !== SettlementStatus.OUTSTANDING) {
      throw new ConflictException(
        `This variance is already ${SETTLEMENT_STATUS_LABELS[row.status].toLowerCase()}, so it cannot be ${action}.`,
      );
    }
  }

  /**
   * The debt is charged to somebody the trip's cash was actually with.
   *
   * The crew who worked it, or an office cash holder who held its float — the same
   * rule the custodian and the allowance recipient obey, asked once in
   * `assertMayHoldTripCash`.
   *
   * Required rather than derived, and that is the point: the settlement is per
   * account because there is no honest way to attribute a returned amount to
   * one release, while a deduction has to name a person. Defaulting to the
   * custodian would be the system inventing an answer to a question only the
   * company can settle — being answerable for ACCOUNTING for cash is not the
   * same as the company having decided to take it out of somebody's pay.
   */
  private assertMayBeCharged(shipmentId: string, staffId: string): Promise<void> {
    return assertMayHoldTripCash(
      this.prisma,
      shipmentId,
      staffId,
      'staffId',
      (shipmentNumber) =>
        `That person neither worked shipment ${shipmentNumber} nor holds trip cash from the office, so this trip's balance cannot be recovered from their pay.`,
    );
  }

  private async load(liquidationId: string): Promise<SettlementRow> {
    const row = await this.prisma.client.settlement.findFirst({
      where: { liquidationId },
      include: SETTLEMENT_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException(
        `Liquidation ${liquidationId} has no settlement. One is created when it is approved.`,
      );
    }

    return row;
  }
}

export function toSettlement(row: SettlementRow): Settlement {
  if (!isSettlementStatus(row.status)) {
    throw new Error(`Settlement ${row.id} has an unrecognised status code ${row.status}`);
  }

  if (row.disbursementMode !== null && !isDisbursementMode(row.disbursementMode)) {
    throw new Error(`Settlement ${row.id} has an unrecognised disbursement mode`);
  }

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment?.shipmentNumber ?? null,

    liquidationId: row.liquidationId,
    custodianId: row.liquidation?.custodianId ?? null,
    custodianName: row.liquidation?.custodian
      ? `${row.liquidation.custodian.firstName} ${row.liquidation.custodian.lastName}`
      : null,

    status: row.status,
    amount: row.amount.toString(),

    disbursementMode: row.disbursementMode,
    referenceNumber: row.referenceNumber,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,

    settledAt: dateToIso(row.settledAt),
    settledBy: row.settledBy,
    settledByName: row.settledByUser?.name ?? null,
    remarks: row.remarks,

    crewDeductionId: row.crewDeductionId,
    crewDeductionRecovered: row.crewDeduction
      ? toDecimalString(sum(row.crewDeduction.recoveries.map((entry) => entry.amount)))
      : null,

    isOutstanding: isAllowanceOutstanding(row.status),

    ...auditFields(row),
  };
}
