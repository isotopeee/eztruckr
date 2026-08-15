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
import { assertMayHoldTripCash } from './trip-cash-participants';

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
  staff: { select: { firstName: true, lastName: true } },
  liquidation: { select: { custodian: { select: { firstName: true, lastName: true } } } },
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

  /**
   * `custodianScope` is the session's, from `accountScopeFor`, and null for the
   * office. A release says who was handed how much and against whose account,
   * so an unscoped list tells a helper what the driver was carrying.
   *
   * THE TOTAL IS SCOPED WITH IT, and has to be: leaving `totalAdvanced` at the
   * trip figure while filtering the rows beneath it would hand the same number
   * back by subtraction, and would also be a lie on its own terms — the crew
   * portal reads this as "what I was given".
   */
  async summary(shipmentId: string, custodianScope: string | null): Promise<AllowanceSummary> {
    const shipment = await this.loadShipment(shipmentId);

    const rows = await this.prisma.client.allowance.findMany({
      where: {
        shipmentId,
        ...(custodianScope ? { liquidation: { custodianId: custodianScope } } : {}),
      },
      include: ALLOWANCE_INCLUDE,
      orderBy: { issuedAt: 'asc' },
    });

    const repeated = await this.repeatedReferenceNumbers(rows);

    return {
      shipmentId,
      // The one figure the variance is measured against. Computed here so no
      // screen has to add up a list and get it subtly different.
      totalAdvanced: toDecimalString(sum(rows.map((row) => row.amount))),
      releaseCount: rows.length,
      routeStandardAllowance: decimalToString(shipment.route?.standardAllowance ?? null),
      canIssue: await this.canIssue(shipmentId),
      allowances: rows.map((row) => {
        const reference = normaliseReference(row.referenceNumber);

        return {
          ...toAllowance(row),
          referenceNumberIsDuplicated: reference !== null && repeated.has(reference),
        };
      }),
    };
  }

  /**
   * Which of these references also appear on another live release.
   *
   * SEARCHED ACROSS EVERY TRIP, not just this one, and that is the case worth
   * catching: a deposit slip entered twice usually lands on two different
   * shipments, which is exactly when nobody notices. Soft-deleted releases are
   * excluded by the client extension — a reference freed by a correction should
   * stop warning about itself.
   *
   * REPORTED, NEVER REFUSED. One bank transfer covering two crew members
   * legitimately carries one reference on both releases, so a unique index
   * would refuse a true record; the screen states it and the person holding the
   * slip decides which of the two they have.
   */
  private async repeatedReferenceNumbers(
    rows: readonly { referenceNumber: string | null }[],
  ): Promise<Set<string>> {
    const references = [
      ...new Set(rows.map((row) => row.referenceNumber).filter((value) => value !== null)),
    ];

    if (references.length === 0) {
      return new Set();
    }

    // MATCHED CASE-INSENSITIVELY, and one `equals` per reference rather than a
    // single `in`, because `in` is exact: "BDO-4417" and "bdo-4417" are the
    // same slip typed by two people, and a check that only catches identical
    // spelling would miss the duplicate at exactly the moment two people
    // recorded it. The list is the references already on this trip, so it is a
    // handful of terms, not a scan of the column.
    const matches = await this.prisma.client.allowance.findMany({
      where: {
        OR: references.map((reference) => ({
          referenceNumber: { equals: reference, mode: 'insensitive' as const },
        })),
      },
      select: { referenceNumber: true },
    });

    const seen = new Map<string, number>();

    for (const match of matches) {
      const key = normaliseReference(match.referenceNumber);
      if (key === null) continue;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }

    return new Set([...seen].filter(([, count]) => count > 1).map(([reference]) => reference));
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
    await this.assertShipmentOpen(shipmentId);
    await this.assertAccountAccepts(shipmentId, input.liquidationId);
    await this.assertMayReceiveCash(shipmentId, input.staffId);
    await this.receipts.assertExists(input.receiptId);

    const releasedBy = input.releasedBy ?? user.id;
    await this.assertUserExists(releasedBy);

    const row = await this.prisma.client.allowance.create({
      data: {
        shipmentId,
        liquidationId: input.liquidationId,
        staffId: input.staffId,
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

    // The account's totals track its releases until approval freezes them, so a
    // top-up issued after the crew submitted still reaches the variance
    // accounting will approve.
    await this.liquidations.refreshTotals(input.liquidationId);

    return toAllowance(row);
  }

  async update(shipmentId: string, id: string, input: UpdateAllowanceInput): Promise<Allowance> {
    await this.assertShipmentOpen(shipmentId);

    const existing = await this.assertBelongs(shipmentId, id);
    // Both the account it is on and the account it is moving to have to be
    // open: a release cannot be pulled out of a frozen variance, and it cannot
    // be pushed into one either.
    await this.assertAccountAccepts(shipmentId, existing.liquidationId);

    if (input.liquidationId !== undefined) {
      await this.assertAccountAccepts(shipmentId, input.liquidationId);
    }

    if (input.staffId !== undefined) {
      await this.assertMayReceiveCash(shipmentId, input.staffId);
    }

    await this.receipts.assertExists(input.receiptId);

    if (input.releasedBy) {
      await this.assertUserExists(input.releasedBy);
    }

    const row = await this.prisma.client.allowance.update({
      where: { id },
      data: {
        ...(input.liquidationId === undefined ? {} : { liquidationId: input.liquidationId }),
        ...(input.staffId === undefined ? {} : { staffId: input.staffId }),
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

    // Both sides, because a move takes the amount off one and adds it to the
    // other, and refreshing only the destination would leave the origin
    // claiming a release it no longer holds.
    await this.liquidations.refreshTotals(existing.liquidationId);
    if (input.liquidationId !== undefined && input.liquidationId !== existing.liquidationId) {
      await this.liquidations.refreshTotals(input.liquidationId);
    }

    return toAllowance(row);
  }

  async remove(shipmentId: string, id: string): Promise<{ removed: true }> {
    await this.assertShipmentOpen(shipmentId);

    const existing = await this.assertBelongs(shipmentId, id);
    await this.assertAccountAccepts(shipmentId, existing.liquidationId);

    await this.prisma.client.allowance.softDelete({ id });
    await this.liquidations.refreshTotals(existing.liquidationId);

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * Whether the screen should offer the form at all.
   *
   * A TRIP-LEVEL answer to a per-account question, so it is the permissive
   * half: true while any account is still open. It used to mean "no liquidation
   * on this trip is approved", which with two custodians would have hidden the
   * form from the helper the moment the driver squared up.
   */
  private async canIssue(shipmentId: string): Promise<boolean> {
    const [openAccounts, shipment] = await Promise.all([
      this.prisma.client.liquidation.count({
        where: { shipmentId, status: { not: LiquidationStatus.APPROVED } },
      }),
      this.prisma.client.shipment.findFirst({
        where: { id: shipmentId },
        select: { status: true },
      }),
    ]);

    return openAccounts > 0 && shipment?.status !== ShipmentStatus.CLOSED;
  }

  private async assertShipmentOpen(shipmentId: string): Promise<void> {
    const shipment = await this.loadShipment(shipmentId);

    if (shipment.status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is closed; no further cash can be released against it.`,
      );
    }
  }

  /**
   * The named account exists, is on this trip, and is not frozen.
   *
   * PER ACCOUNT, and that is the point of the change. Approval freezes a
   * variance measured against that account's releases, so a release added
   * afterwards would make its settlement wrong by exactly its amount — but only
   * ITS settlement. Refusing every account on the trip because one was approved
   * would stop the helper being paid ferry money because the driver had already
   * squared up.
   *
   * The trip check is belt-and-braces over the composite foreign key, which
   * cannot be talked out of it; this exists so the answer is a sentence rather
   * than a constraint name.
   */
  private async assertAccountAccepts(shipmentId: string, liquidationId: string): Promise<void> {
    const liquidation = await this.prisma.client.liquidation.findFirst({
      where: { id: liquidationId },
      select: {
        shipmentId: true,
        status: true,
        custodian: { select: { firstName: true, lastName: true } },
      },
    });

    if (!liquidation || liquidation.shipmentId !== shipmentId) {
      throw badRequest(
        'liquidationId',
        `No liquidation ${liquidationId} on this shipment. A release has to be booked against an account belonging to the trip it is for.`,
      );
    }

    if (liquidation.status === LiquidationStatus.APPROVED) {
      const who = liquidation.custodian
        ? `${liquidation.custodian.firstName} ${liquidation.custodian.lastName}'s account`
        : 'That account';

      throw new ConflictException(
        `${who} is approved, so its total advanced is frozen. Reverse the approval, with a reason, or book the release against another account.`,
      );
    }
  }

  /**
   * Cash goes to somebody the trip's money could actually reach.
   *
   * The crew who worked it, or an office cash holder holding its float — the same
   * rule the custodian and the carried deduction obey, asked once in
   * `assertMayHoldTripCash`. A dispatch manager is a recipient and not only an
   * answerable party, because the float is physically handed to them.
   *
   * Not merely an existing staff member: a release to somebody with no
   * connection to the trip is either a typo or a problem.
   */
  private assertMayReceiveCash(shipmentId: string, staffId: string): Promise<void> {
    return assertMayHoldTripCash(
      this.prisma,
      shipmentId,
      staffId,
      'staffId',
      (shipmentNumber) =>
        `That person neither worked shipment ${shipmentNumber} nor holds trip cash from the office, so cash cannot be released to them against it.`,
    );
  }

  private async assertUserExists(userId: string): Promise<void> {
    const found = await this.prisma.client.user.findFirst({
      where: { id: userId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest('releasedBy', `No user with id ${userId}`);
    }
  }

  /**
   * The id is checked against the shipment in the path, not just the table —
   * the same rule the charge services follow, and for the same reason: without
   * it, one trip's status would govern another trip's money.
   */
  private async assertBelongs(
    shipmentId: string,
    id: string,
  ): Promise<{ id: string; liquidationId: string }> {
    const found = await this.prisma.client.allowance.findFirst({
      where: { id, shipmentId },
      select: { id: true, liquidationId: true },
    });

    if (!found) {
      throw new NotFoundException(`No allowance ${id} on shipment ${shipmentId}`);
    }

    return found;
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

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}

/**
 * A reference as the duplicate check compares it: trimmed, lowercased, and null
 * when there is nothing left. The web form normalises the same way as it is
 * typed, so the warning before saving and the warning after it agree.
 */
function normaliseReference(reference: string | null): string | null {
  const trimmed = reference?.trim().toLowerCase();

  return trimmed ? trimmed : null;
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
    liquidationId: row.liquidationId,
    custodianName: row.liquidation?.custodian
      ? `${row.liquidation.custodian.firstName} ${row.liquidation.custodian.lastName}`
      : null,
    staffId: row.staffId,
    staffName: row.staff ? `${row.staff.firstName} ${row.staff.lastName}` : null,
    amount: row.amount.toString(),
    issuedAt: row.issuedAt.toISOString(),
    remarks: row.remarks,
    releasedBy: row.releasedBy,
    releasedByName: row.releasedByUser?.name ?? null,
    disbursementMode: row.disbursementMode,
    referenceNumber: row.referenceNumber,
    // Costs a query to answer, so only the summary pays for it and overrides
    // this. False means "not checked" — the safe way round, since it never
    // claims a reference is unique when nothing has looked.
    referenceNumberIsDuplicated: false,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    ...auditFields(row),
  };
}
