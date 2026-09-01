import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  AllowanceRequestStatus,
  expectsProofOfRelease,
  isAllowanceRequestStatus,
  liquidationAccountLabel,
  LiquidationStatus,
  ShipmentStatus,
  type AllowanceRequest,
  type AllowanceRequestListQuery,
  type ApproveAllowanceRequestInput,
  type CreateAllowanceRequestInput,
  type DeclineAllowanceRequestInput,
  type UpdateAllowanceRequestInput,
} from '@eztruckr/types';
import type { RequestUser } from '../auth/request-user';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { ALLOWANCE_INCLUDE, AllowancesService } from './allowances.service';
import { LiquidationService } from './liquidation.service';
import { assertMayHoldTripCash } from './trip-cash-participants';

/**
 * The ask, and accounting's answer to it.
 *
 * WHY THIS SERVICE EXISTS AT ALL is a permission, not a workflow preference.
 * `CAN_WRITE_SHIPMENT_MONEY` keeps both dispatch roles out of releasing cash,
 * because they hold trip floats themselves and would otherwise be paying
 * themselves. That control is right and it stays; what it left behind was a
 * dispatch manager who knows the truck leaves at five and had no way to say so
 * inside the system. This is that sentence, recorded.
 *
 * AN APPROVAL IS A RELEASE. It creates an ordinary `Allowance`, on the ordinary
 * account, counted in the ordinary total advanced — the guards it passes are
 * `AllowancesService.assertMayRelease`, the same five the direct form passes,
 * borrowed rather than restated. Nothing downstream of a release knows this
 * table exists.
 *
 * WHAT IS STRICTER HERE THAN THERE, and the only thing: a transfer or an
 * e-wallet payment must carry its proof. See `expectsProofOfRelease` for why
 * that rule belongs on this path and not on the other one — in short, because
 * the person who asked and the person who paid are two people, and the document
 * is what connects them.
 */

const REQUEST_INCLUDE = {
  shipment: { select: { shipmentNumber: true } },
  liquidation: {
    select: { sequence: true, custodian: { select: { firstName: true, lastName: true } } },
  },
  staff: { select: { firstName: true, lastName: true } },
  requestedByUser: { select: { name: true } },
  decidedByUser: { select: { name: true } },
} satisfies Prisma.AllowanceRequestInclude;

type RequestRow = Prisma.AllowanceRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

@Injectable()
export class AllowanceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allowances: AllowancesService,
    private readonly liquidations: LiquidationService,
  ) {}

  /** Every request raised on one trip, oldest first — the order they happened. */
  async listForShipment(shipmentId: string): Promise<AllowanceRequest[]> {
    await this.loadShipment(shipmentId);

    const rows = await this.prisma.client.allowanceRequest.findMany({
      where: { shipmentId },
      include: REQUEST_INCLUDE,
      orderBy: { requestedAt: 'asc' },
    });

    return rows.map(toAllowanceRequest);
  }

  /**
   * The cross-trip queue: what accounting has waiting on them.
   *
   * NEWEST LAST, like the per-trip list, because a queue worked from the top is
   * a queue worked oldest-first — and the request that has been sitting longest
   * is the truck that has been waiting longest.
   *
   * UNSCOPED. Every role that can reach this endpoint reads every shipment
   * already, so filtering it to the caller's own requests would hide a dispatch
   * manager's colleague's ask from them while leaving it one click away on the
   * trip. Crew cannot reach it at all — a request is not yet money.
   */
  async list(query: AllowanceRequestListQuery): Promise<AllowanceRequest[]> {
    const rows = await this.prisma.client.allowanceRequest.findMany({
      where: { status: query.status },
      include: REQUEST_INCLUDE,
      orderBy: { requestedAt: 'asc' },
    });

    return rows.map(toAllowanceRequest);
  }

  async get(id: string): Promise<AllowanceRequest> {
    return toAllowanceRequest(await this.load(id));
  }

  /**
   * Raising one.
   *
   * VALIDATED AS IF IT WERE THE RELEASE, on purpose. The account has to exist on
   * this trip and still be open, and the recipient has to be somebody the trip's
   * money could reach — the same questions approval will ask again. Asking them
   * now means dispatch is refused while they are still looking at the form,
   * rather than accounting discovering an hour later that the ask was never
   * payable.
   *
   * ASKED TWICE, NOT ONCE, and the repetition is the point: crew get swapped and
   * accounts get approved between the ask and the payment, so a request that was
   * valid on Tuesday may not be on Wednesday. This check is a courtesy; the one
   * inside `approve` is the control.
   */
  async create(
    shipmentId: string,
    input: CreateAllowanceRequestInput,
    user: RequestUser,
  ): Promise<AllowanceRequest> {
    await this.assertShipmentOpen(shipmentId);
    await this.assertAccountAccepts(shipmentId, input.liquidationId);
    await this.assertMayReceiveCash(shipmentId, input.staffId);

    const row = await this.prisma.client.allowanceRequest.create({
      data: {
        shipmentId,
        liquidationId: input.liquidationId,
        staffId: input.staffId,
        amount: input.amount,
        purpose: input.purpose,
        status: AllowanceRequestStatus.PENDING,
        requestedBy: user.id,
      },
      include: REQUEST_INCLUDE,
    });

    return toAllowanceRequest(row);
  }

  /**
   * Correcting an ask nobody has answered yet.
   *
   * RE-VALIDATED, NOT JUST REWRITTEN. Every field this can move is one the
   * create checked, and the answers can have changed since: an account can be
   * approved and a crew member swapped between raising and correcting. Only the
   * fields actually supplied are re-asked, so moving an amount does not pay for
   * a lookup on an account nobody touched.
   *
   * WHAT IT DOES NOT DO IS HIDE ITSELF. The row's `updatedAt` moves, and
   * `editedAfterRaising` reports that on every read while the request is still
   * waiting — see the schema for why that matters when the person approving is
   * not the person who typed it.
   */
  async update(
    shipmentId: string,
    id: string,
    input: UpdateAllowanceRequestInput,
  ): Promise<AllowanceRequest> {
    const request = await this.assertBelongs(shipmentId, id);

    this.assertPending(request, 'edited');
    await this.assertShipmentOpen(shipmentId);

    // The account it is moving TO, when it is moving — and the one it is
    // already on otherwise, because an ask sitting on an account that has since
    // been approved cannot be corrected into payability.
    await this.assertAccountAccepts(shipmentId, input.liquidationId ?? request.liquidationId);

    if (input.staffId !== undefined) {
      await this.assertMayReceiveCash(shipmentId, input.staffId);
    }

    await this.prisma.client.allowanceRequest.update({
      where: { id },
      data: {
        ...(input.liquidationId === undefined ? {} : { liquidationId: input.liquidationId }),
        ...(input.staffId === undefined ? {} : { staffId: input.staffId }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
      },
    });

    return this.get(id);
  }

  /**
   * Approving: the cash actually moves, and this row records that it did.
   *
   * ONE TRANSACTION, and it has to be. The decision CHECK requires an approved
   * request to name the release it produced, so a create that succeeded beside
   * an update that failed would leave a row the database itself refuses — and
   * the other order leaves a release nobody asked for. Both statements go
   * together or neither does.
   *
   * THE AMOUNT IS THE REQUEST'S, never the approver's. Releasing less than was
   * asked for is a refusal of this request, not an approval of a different one,
   * and it goes back as a decline with the reason that lets dispatch raise an
   * ask they can live with. An approval beside a figure nobody agreed to is the
   * one outcome this record exists to prevent.
   */
  async approve(
    id: string,
    input: ApproveAllowanceRequestInput,
    user: RequestUser,
  ): Promise<AllowanceRequest> {
    const request = await this.load(id);

    this.assertPending(request, 'approved');

    // Belt and braces over the schema's own refinement: a caller that reaches
    // the service by another route still cannot release a transfer with nothing
    // behind it.
    if (expectsProofOfRelease(input.disbursementMode) && input.receiptId === null) {
      throw badRequest(
        'receiptId',
        'Attach the transfer confirmation or wallet screenshot before approving. A release paid this way already produced one, and it is what ties the money to the person who asked for it.',
      );
    }

    const releasedBy = input.releasedBy ?? user.id;

    // The five that decide whether cash may leave, borrowed whole from the
    // direct-release path rather than restated here.
    await this.allowances.assertMayRelease(request.shipmentId, {
      liquidationId: request.liquidationId,
      staffId: request.staffId,
      receiptId: input.receiptId,
      releasedBy,
    });

    await this.prisma.client.$transaction(async (tx) => {
      const allowance = await tx.allowance.create({
        data: {
          shipmentId: request.shipmentId,
          liquidationId: request.liquidationId,
          staffId: request.staffId,
          // The requested figure, carried across untouched.
          amount: request.amount,
          issuedAt: input.issuedAt === null ? new Date() : new Date(input.issuedAt),
          disbursementMode: input.disbursementMode,
          referenceNumber: input.referenceNumber,
          receiptId: input.receiptId,
          releasedBy,
          // The approver may say something about the payment; otherwise the
          // release inherits why it was asked for. Always a sentence now that
          // `purpose` is mandatory, so a release created this way can never
          // carry the blank remark somebody reads in six months.
          remarks: input.remarks ?? request.purpose,
        },
        include: ALLOWANCE_INCLUDE,
      });

      await tx.allowanceRequest.update({
        where: { id: request.id },
        data: {
          status: AllowanceRequestStatus.APPROVED,
          decidedBy: user.id,
          decidedAt: new Date(),
          allowanceId: allowance.id,
        },
      });
    });

    // Outside the transaction, exactly as `issue` does it: the account's totals
    // track its releases until approval freezes them, so the custodian's
    // variance moves by what was just handed over.
    await this.liquidations.refreshTotals(request.liquidationId);

    return this.get(id);
  }

  /**
   * Refusing, with the reason that makes it actionable.
   *
   * Terminal, and it stays terminal now that a PENDING ask can be edited:
   * `update` refuses a decided one. Dispatch raises a new request rather than
   * rewriting this one — "₱10,000, declined, too much" followed by "₱6,000,
   * approved" is two facts worth keeping, and an editable decision keeps
   * neither.
   */
  async decline(
    id: string,
    input: DeclineAllowanceRequestInput,
    user: RequestUser,
  ): Promise<AllowanceRequest> {
    const request = await this.load(id);

    this.assertPending(request, 'declined');

    await this.prisma.client.allowanceRequest.update({
      where: { id: request.id },
      data: {
        status: AllowanceRequestStatus.DECLINED,
        decidedBy: user.id,
        decidedAt: new Date(),
        decisionReason: input.reason,
      },
    });

    return this.get(id);
  }

  /**
   * Withdrawing an ask nobody has answered.
   *
   * A SOFT DELETE RATHER THAN A FOURTH STATUS. `deletedBy` and `deletedAt`
   * already record who called it off and when, which is the only question a
   * `CANCELLED` code would have answered, and a removed row is already absent
   * from every list without a single query learning about it.
   *
   * Only while PENDING. A decided request is the record of a decision, and
   * removing one would take accounting's answer with it.
   */
  async withdraw(shipmentId: string, id: string): Promise<{ removed: true }> {
    const request = await this.assertBelongs(shipmentId, id);

    this.assertPending(request, 'withdrawn');

    await this.prisma.client.allowanceRequest.softDelete({ id });

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * Refuses anything already answered, naming what was tried.
   *
   * Asked through `isAllowanceRequestDecided`'s sibling rather than by comparing
   * to PENDING inline in three places, so a status appended later cannot be
   * treated as open by one method and closed by another.
   */
  private assertPending(request: RequestRow, attempted: string): void {
    if (request.status === AllowanceRequestStatus.PENDING) {
      return;
    }

    const already =
      request.status === AllowanceRequestStatus.APPROVED ? 'approved' : 'already declined';

    throw new ConflictException(
      `This request was ${already}, so it cannot be ${attempted}. Raise a new request instead — the decision on this one is the record of what was asked and answered.`,
    );
  }

  private async assertShipmentOpen(shipmentId: string): Promise<void> {
    const shipment = await this.loadShipment(shipmentId);

    if (shipment.status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is closed; no further cash can be requested against it.`,
      );
    }
  }

  /**
   * The named account exists, is on this trip, and is not frozen.
   *
   * The same three questions `AllowancesService` asks before a release, worded
   * for an ask rather than a payment: there is nothing to release against an
   * approved account, so there is nothing to request against one either.
   */
  private async assertAccountAccepts(shipmentId: string, liquidationId: string): Promise<void> {
    const liquidation = await this.prisma.client.liquidation.findFirst({
      where: { id: liquidationId },
      select: {
        shipmentId: true,
        sequence: true,
        status: true,
        custodian: { select: { firstName: true, lastName: true } },
      },
    });

    if (!liquidation || liquidation.shipmentId !== shipmentId) {
      throw badRequest(
        'liquidationId',
        `No liquidation ${liquidationId} on this shipment. A request has to name an account belonging to the trip it is for.`,
      );
    }

    if (liquidation.status === LiquidationStatus.APPROVED) {
      // The number as well as the name — "request against another account" may
      // mean another of the SAME person's, and a name on its own cannot say
      // which of the two is closed.
      const who = liquidationAccountLabel(
        liquidation.custodian
          ? `${liquidation.custodian.firstName} ${liquidation.custodian.lastName}`
          : null,
        liquidation.sequence,
      );

      throw new ConflictException(
        `${who} is approved, so its total advanced is frozen and nothing further can be released against it. Request against another account, or ask accounting to reverse the approval.`,
      );
    }
  }

  /** Cash goes to somebody the trip's money could actually reach. */
  private assertMayReceiveCash(shipmentId: string, staffId: string): Promise<void> {
    return assertMayHoldTripCash(
      this.prisma,
      shipmentId,
      staffId,
      'staffId',
      (shipmentNumber) =>
        `That person neither worked shipment ${shipmentNumber} nor holds trip cash from the office, so cash cannot be requested for them against it.`,
    );
  }

  private async load(id: string): Promise<RequestRow> {
    const row = await this.prisma.client.allowanceRequest.findFirst({
      where: { id },
      include: REQUEST_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException(`No allowance request with id ${id}`);
    }

    return row;
  }

  /**
   * Checked against the shipment in the path and not just the table, the same
   * rule the release and charge services follow: without it, one trip's status
   * would govern another trip's paperwork.
   */
  private async assertBelongs(shipmentId: string, id: string): Promise<RequestRow> {
    const row = await this.prisma.client.allowanceRequest.findFirst({
      where: { id, shipmentId },
      include: REQUEST_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException(`No allowance request ${id} on shipment ${shipmentId}`);
    }

    return row;
  }

  private async loadShipment(shipmentId: string) {
    const shipment = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId },
      select: { id: true, shipmentNumber: true, status: true },
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

export function toAllowanceRequest(row: RequestRow): AllowanceRequest {
  if (!isAllowanceRequestStatus(row.status)) {
    // The column carries a CHECK, so this needs raw SQL to reach. Failing
    // loudly beats returning a request nobody can interpret.
    throw new Error(`Allowance request ${row.id} has an unrecognised status`);
  }

  return {
    id: row.id,
    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment?.shipmentNumber ?? null,
    liquidationId: row.liquidationId,
    custodianName: row.liquidation?.custodian
      ? `${row.liquidation.custodian.firstName} ${row.liquidation.custodian.lastName}`
      : null,
    liquidationSequence: row.liquidation.sequence,
    staffId: row.staffId,
    staffName: row.staff ? `${row.staff.firstName} ${row.staff.lastName}` : null,
    amount: row.amount.toString(),
    purpose: row.purpose,
    status: row.status,
    requestedBy: row.requestedBy,
    requestedByName: row.requestedByUser?.name ?? null,
    requestedAt: row.requestedAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedByName: row.decidedByUser?.name ?? null,
    decidedAt: dateToIso(row.decidedAt),
    decisionReason: row.decisionReason,
    allowanceId: row.allowanceId,
    // Derived, never stored, so it cannot disagree with the row. Pending only:
    // FROM `updatedBy`, NOT FROM THE CLOCKS. The audit extension forces this
    // column to null on create and stamps it on every update, so "has this row
    // been modified" is exact. Comparing `updatedAt` to `requestedAt` was the
    // obvious alternative and is a guess: one is Prisma's clock and the other
    // is Postgres's `CURRENT_TIMESTAMP`, so they disagree by milliseconds on a
    // row nobody has touched, in whichever direction the two happen to fall.
    //
    // Still gated on PENDING: deciding is an update too, and reporting every
    // approved request as "edited" would make the marker mean nothing.
    editedAfterRaising: row.status === AllowanceRequestStatus.PENDING && row.updatedBy !== null,
    ...auditFields(row),
  };
}
