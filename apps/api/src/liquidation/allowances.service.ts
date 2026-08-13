import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  isDisbursementMode,
  LiquidationStatus,
  ShipmentStatus,
  sum,
  toDecimalString,
  type Allowance,
  type AllowanceSummary,
  type IssueAllowanceInput,
  type UpdateAllowanceInput,
} from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { auditFields, decimalToString } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { LiquidationService } from './liquidation.service';
import { ReceiptsService } from './receipts.service';

/**
 * Issuing allowances: one row per release, never an editable running total.
 *
 * The distinction this service exists to protect is that "how much has this
 * trip been advanced" is a QUESTION, answered by summing releases, not a FIELD.
 * A field would have to be overwritten when the driver phones in for ferry
 * money, and the first release would then have no record it ever happened —
 * along with its date, its mode and whoever handed it over.
 */

const ALLOWANCE_INCLUDE = {
  crewMember: { select: { firstName: true, lastName: true } },
  releasedByUser: { select: { name: true } },
  receipt: { select: { fileName: true } },
} satisfies Prisma.AllowanceInclude;

type AllowanceRow = Prisma.AllowanceGetPayload<{ include: typeof ALLOWANCE_INCLUDE }>;

@Injectable()
export class AllowancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: ReceiptsService,
    private readonly liquidations: LiquidationService,
  ) {}

  async summary(shipmentId: string): Promise<AllowanceSummary> {
    const shipment = await this.loadShipment(shipmentId);

    const rows = await this.prisma.client.allowance.findMany({
      where: { shipmentId },
      include: ALLOWANCE_INCLUDE,
      orderBy: { issuedAt: 'asc' },
    });

    return {
      shipmentId,
      // The one figure the variance is measured against. Computed here so no
      // screen has to add up a list and get it subtly different.
      totalAdvanced: toDecimalString(sum(rows.map((row) => row.amount))),
      releaseCount: rows.length,
      routeStandardAllowance: decimalToString(shipment.route?.standardAllowance ?? null),
      canIssue: await this.canIssue(shipmentId),
      allowances: rows.map(toAllowance),
    };
  }

  /**
   * Records a release.
   *
   * `releasedBy` defaults to the caller and may name somebody else, because the
   * person who hands cash over in the yard is routinely not the person who
   * types it in that afternoon.
   */
  async issue(
    shipmentId: string,
    input: IssueAllowanceInput,
    user: RequestUser,
  ): Promise<Allowance> {
    await this.assertIssuable(shipmentId);
    await this.assertCrewOnTrip(shipmentId, input.crewMemberId);
    await this.receipts.assertExists(input.receiptId);

    const releasedBy = input.releasedBy ?? user.id;
    await this.assertUserExists(releasedBy);

    const row = await this.prisma.client.allowance.create({
      data: {
        shipmentId,
        crewMemberId: input.crewMemberId,
        amount: input.amount,
        issuedAt: input.issuedAt === null ? new Date() : new Date(input.issuedAt),
        disbursementMode: input.disbursementMode,
        referenceNumber: input.referenceNumber,
        receiptId: input.receiptId,
        releasedBy,
        remarks: input.remarks,
      },
      include: ALLOWANCE_INCLUDE,
    });

    // The liquidation's frozen-at-approval totals track the releases until
    // they are frozen, so a top-up issued after the crew submitted still
    // reaches the variance accounting will approve.
    await this.liquidations.refreshTotals(shipmentId);

    return toAllowance(row);
  }

  async update(shipmentId: string, id: string, input: UpdateAllowanceInput): Promise<Allowance> {
    await this.assertIssuable(shipmentId);
    await this.assertBelongs(shipmentId, id);

    if (input.crewMemberId !== undefined) {
      await this.assertCrewOnTrip(shipmentId, input.crewMemberId);
    }

    await this.receipts.assertExists(input.receiptId);

    if (input.releasedBy) {
      await this.assertUserExists(input.releasedBy);
    }

    const row = await this.prisma.client.allowance.update({
      where: { id },
      data: {
        ...(input.crewMemberId === undefined ? {} : { crewMemberId: input.crewMemberId }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.issuedAt === undefined || input.issuedAt === null
          ? {}
          : { issuedAt: new Date(input.issuedAt) }),
        ...(input.disbursementMode === undefined
          ? {}
          : { disbursementMode: input.disbursementMode }),
        ...(input.referenceNumber === undefined ? {} : { referenceNumber: input.referenceNumber }),
        ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        ...(input.releasedBy ? { releasedBy: input.releasedBy } : {}),
        ...(input.remarks === undefined ? {} : { remarks: input.remarks }),
      },
      include: ALLOWANCE_INCLUDE,
    });

    await this.liquidations.refreshTotals(shipmentId);

    return toAllowance(row);
  }

  async remove(shipmentId: string, id: string): Promise<{ removed: true }> {
    await this.assertIssuable(shipmentId);
    await this.assertBelongs(shipmentId, id);

    await this.prisma.client.allowance.softDelete({ id });
    await this.liquidations.refreshTotals(shipmentId);

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * Releases stop once the trip's liquidation is approved.
   *
   * Approval freezes the variance, and the variance is measured against the sum
   * of the releases — so a release added afterwards would make the settlement
   * on file wrong by exactly its amount, silently. Reversing the approval, with
   * a reason, reopens this. That is the whole point of reversal existing.
   */
  private async canIssue(shipmentId: string): Promise<boolean> {
    const [approved, shipment] = await Promise.all([
      this.liquidations.isApproved(shipmentId),
      this.prisma.client.shipment.findFirst({
        where: { id: shipmentId },
        select: { status: true },
      }),
    ]);

    return !approved && shipment?.status !== ShipmentStatus.CLOSED;
  }

  private async assertIssuable(shipmentId: string): Promise<void> {
    const shipment = await this.loadShipment(shipmentId);

    if (shipment.status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is closed; no further cash can be released against it.`,
      );
    }

    const approved = await this.prisma.client.liquidation.count({
      where: { shipmentId, status: LiquidationStatus.APPROVED },
    });

    if (approved > 0) {
      throw new ConflictException(
        `The liquidation for shipment ${shipment.shipmentNumber} is approved, so its total advanced is frozen. Reverse the approval, with a reason, to record another release.`,
      );
    }
  }

  /**
   * Cash goes to somebody who is on the trip.
   *
   * Not merely to an existing crew member: an allowance against a shipment
   * names the person accountable for that trip's money, and a release to
   * somebody who never worked it is either a typo or a problem.
   */
  private async assertCrewOnTrip(shipmentId: string, crewMemberId: string): Promise<void> {
    const shipment = await this.loadShipment(shipmentId);

    if (shipment.driverId !== crewMemberId && shipment.helperId !== crewMemberId) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [
          {
            path: 'crewMemberId',
            message: `That crew member is not assigned to shipment ${shipment.shipmentNumber}.`,
          },
        ],
      });
    }
  }

  private async assertUserExists(userId: string): Promise<void> {
    const found = await this.prisma.client.user.findFirst({
      where: { id: userId },
      select: { id: true },
    });

    if (!found) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'releasedBy', message: `No user with id ${userId}` }],
      });
    }
  }

  /**
   * The id is checked against the shipment in the path, not just the table —
   * the same rule the charge services follow, and for the same reason: without
   * it, one trip's status would govern another trip's money.
   */
  private async assertBelongs(shipmentId: string, id: string): Promise<void> {
    const found = await this.prisma.client.allowance.findFirst({
      where: { id, shipmentId },
      select: { id: true },
    });

    if (!found) {
      throw new NotFoundException(`No allowance ${id} on shipment ${shipmentId}`);
    }
  }

  private async loadShipment(shipmentId: string) {
    const shipment = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId },
      select: {
        id: true,
        shipmentNumber: true,
        status: true,
        driverId: true,
        helperId: true,
        route: { select: { standardAllowance: true } },
      },
    });

    if (!shipment) {
      throw new NotFoundException(`No shipment with id ${shipmentId}`);
    }

    return shipment;
  }
}

export function toAllowance(row: AllowanceRow): Allowance {
  if (!isDisbursementMode(row.disbursementMode)) {
    // The column carries a CHECK, so this needs raw SQL to reach. Failing
    // loudly beats returning a release nobody can interpret.
    throw new Error(`Allowance ${row.id} has an unrecognised disbursement mode`);
  }

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    crewMemberId: row.crewMemberId,
    crewMemberName: row.crewMember
      ? `${row.crewMember.firstName} ${row.crewMember.lastName}`
      : null,
    amount: row.amount.toString(),
    issuedAt: row.issuedAt.toISOString(),
    remarks: row.remarks,
    releasedBy: row.releasedBy,
    releasedByName: row.releasedByUser?.name ?? null,
    disbursementMode: row.disbursementMode,
    referenceNumber: row.referenceNumber,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    ...auditFields(row),
  };
}
