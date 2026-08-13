import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  isAdjustmentDirection,
  money,
  signedAdjustmentAmount,
  sumAdjustments,
  toDecimalString,
  zero,
  type Adjustment,
  type AdjustmentListQuery,
  type CreateAdjustmentInput,
  type CrewPayLine,
  type UpdateAdjustmentInput,
} from '@eztruckr/types';
import { auditFields } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { toCommissionResponse } from './commission.service';

/**
 * Manual increases and decreases to crew pay.
 *
 * THE COMMISSION IS NEVER TOUCHED. Every other way of doing this ends up
 * writing into `Commission.amount`, and that row is the one thing in the system
 * that states its own arithmetic — base x rate = amount, from values on the row
 * — which is what makes a voucher re-derivable a year later. An adjustment is a
 * sibling row, and `crewPayForShipment` is the only place the two are added.
 *
 * THE LOCK IS THE ADJUSTMENT'S OWN PAYOUT LINE, not the commission's. Those are
 * different facts and conflating them gets the behaviour backwards in both
 * directions: a trip whose commission was already paid can still legitimately
 * receive an adjustment — "we underpaid you on that run, here is the ₱500 on
 * the next one" is the normal way that correction happens — while an adjustment
 * that has itself been paid cannot be edited, because the voucher naming it has
 * to keep reconciling.
 */

const ADJUSTMENT_INCLUDE = {
  staff: { select: { firstName: true, lastName: true } },
  shipment: { select: { shipmentNumber: true } },
  approvedByUser: { select: { name: true } },
} satisfies Prisma.AdjustmentInclude;

type AdjustmentRow = Prisma.AdjustmentGetPayload<{ include: typeof ADJUSTMENT_INCLUDE }>;

@Injectable()
export class AdjustmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private get adjustments() {
    return this.prisma.client.adjustment;
  }

  /**
   * The list, filtered.
   *
   * `staffId` is OVERWRITTEN rather than validated for a crew session —
   * the controller passes the session's own id, and there is no query string
   * that widens it. Same rule as the shipment and liquidation lists.
   */
  async list(query: AdjustmentListQuery): Promise<Adjustment[]> {
    const rows = await this.adjustments.findMany({
      where: {
        ...(query.staffId ? { staffId: query.staffId } : {}),
        ...(query.shipmentId ? { shipmentId: query.shipmentId } : {}),
        ...(query.unpaidOnly ? { payoutLineId: null } : {}),
      },
      include: ADJUSTMENT_INCLUDE,
      orderBy: [{ approvedAt: 'desc' }],
    });

    return rows.map(toAdjustment);
  }

  async create(input: CreateAdjustmentInput, approvedBy: string): Promise<Adjustment> {
    await this.assertStaffExists(input.staffId);
    await this.assertWorkedTheTrip(input.shipmentId, input.staffId);

    const row = await this.adjustments.create({
      data: {
        staffId: input.staffId,
        shipmentId: input.shipmentId,
        direction: input.direction,
        amount: input.amount,
        reason: input.reason,
        // From the session, never from the body. The endpoint is restricted to
        // the roles that may authorise a change to somebody's pay, so the
        // caller IS the approver — accepting a name would let the record claim
        // an authorisation that never happened.
        approvedBy,
      },
      include: ADJUSTMENT_INCLUDE,
    });

    return toAdjustment(row);
  }

  async update(id: string, input: UpdateAdjustmentInput): Promise<Adjustment> {
    await this.assertUnpaid(id);

    const row = await this.adjustments.update({
      where: { id },
      data: {
        ...(input.direction === undefined ? {} : { direction: input.direction }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      },
      include: ADJUSTMENT_INCLUDE,
    });

    return toAdjustment(row);
  }

  async remove(id: string): Promise<{ removed: true }> {
    await this.assertUnpaid(id);

    await this.adjustments.softDelete({ id });

    return { removed: true };
  }

  /**
   * What each crew member is actually owed for one trip.
   *
   * Keyed on the crew member rather than on the commission, so an adjustment
   * agreed before commissions were computed — or one naming somebody whose slot
   * has since changed — appears in the total instead of being silently dropped
   * by a join that found no commission to hang it on.
   */
  async crewPayForShipment(shipmentId: string): Promise<CrewPayLine[]> {
    const [commissions, adjustments] = await Promise.all([
      this.prisma.client.commission.findMany({
        where: { shipmentId },
        orderBy: { role: 'asc' },
        include: {
          staff: { select: { firstName: true, lastName: true } },
          shipment: { select: { shipmentNumber: true } },
        },
      }),
      this.adjustments.findMany({
        where: { shipmentId },
        include: ADJUSTMENT_INCLUDE,
        orderBy: [{ approvedAt: 'asc' }],
      }),
    ]);

    const names = new Map<string, string>();
    const order: string[] = [];

    const remember = (staffId: string, name: string) => {
      if (!names.has(staffId)) {
        names.set(staffId, name);
        order.push(staffId);
      }
    };

    // Commissions first, so the people who were paid for the trip lead the
    // list and an adjustment-only crew member follows rather than displacing.
    for (const row of commissions) {
      remember(row.staffId, `${row.staff.firstName} ${row.staff.lastName}`);
    }
    for (const row of adjustments) {
      remember(row.staffId, `${row.staff.firstName} ${row.staff.lastName}`);
    }

    return order.map((staffId) => {
      const commission = commissions.find((row) => row.staffId === staffId) ?? null;

      // Serialised BEFORE summing, not after. `toAdjustment` is what validates
      // the direction code against the set, so summing the raw rows would be
      // adding up a `number` that nothing had checked was a direction at all.
      const own = adjustments.filter((row) => row.staffId === staffId).map(toAdjustment);

      const commissionAmount = commission ? money(commission.amount) : zero();
      const adjustmentsTotal = sumAdjustments(own);

      return {
        staffId,
        staffName: names.get(staffId) ?? '',
        commission: commission
          ? toCommissionResponse(commission, commission.shipment.shipmentNumber)
          : null,
        commissionAmount: toDecimalString(commissionAmount),
        adjustments: own,
        adjustmentsTotal,
        netAmount: toDecimalString(commissionAmount.add(money(adjustmentsTotal))),
      };
    });
  }

  /** The crew member an adjustment belongs to, for the controller's scoping. */
  async staffOf(id: string): Promise<string> {
    const row = await this.adjustments.findFirst({
      where: { id },
      select: { staffId: true },
    });

    if (!row) {
      throw new NotFoundException(`No adjustment with id ${id}`);
    }

    return row.staffId;
  }

  // -------------------------------------------------------------------------

  private async assertUnpaid(id: string): Promise<void> {
    const row = await this.adjustments.findFirst({
      where: { id },
      select: { payoutLineId: true, reason: true },
    });

    if (!row) {
      throw new NotFoundException(`No adjustment with id ${id}`);
    }

    if (row.payoutLineId !== null) {
      throw new ConflictException(
        `This adjustment (${row.reason}) has already been paid out, so it can no longer be changed. Record a further adjustment instead.`,
      );
    }
  }

  private async assertStaffExists(staffId: string): Promise<void> {
    const crew = await this.prisma.client.staff.findFirst({
      where: { id: staffId },
      select: { id: true },
    });

    if (!crew) {
      throw badRequest('staffId', `No crew member with id ${staffId}`);
    }
  }

  /**
   * An adjustment against a trip has to name somebody who was on it.
   *
   * Not expressible as a CHECK — the answer lives in two columns on another
   * table — which is exactly why it is asserted here rather than trusted. An
   * adjustment against a trip a person never worked is a typo with a peso
   * value on it, and it would sail through every other guard in this file.
   */
  private async assertWorkedTheTrip(shipmentId: string | null, staffId: string): Promise<void> {
    if (shipmentId === null) return;

    const shipment = await this.prisma.client.shipment.findFirst({
      where: { id: shipmentId },
      select: { shipmentNumber: true, driverId: true, helperId: true },
    });

    if (!shipment) {
      throw badRequest('shipmentId', `No shipment with id ${shipmentId}`);
    }

    if (shipment.driverId !== staffId && shipment.helperId !== staffId) {
      throw badRequest(
        'staffId',
        `That crew member did not work shipment ${shipment.shipmentNumber}, so their pay for it cannot be adjusted. Leave the trip off for a standing adjustment.`,
      );
    }
  }
}

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}

export function toAdjustment(row: AdjustmentRow): Adjustment {
  if (!isAdjustmentDirection(row.direction)) {
    // The column carries a CHECK, so reaching this needs raw SQL. Failing
    // loudly beats returning an adjustment whose sign nobody can determine.
    throw new Error(`Adjustment ${row.id} has an unrecognised direction code ${row.direction}`);
  }

  const amount = row.amount.toString();

  return {
    id: row.id,
    staffId: row.staffId,
    staffName: row.staff ? `${row.staff.firstName} ${row.staff.lastName}` : null,

    shipmentId: row.shipmentId,
    shipmentNumber: row.shipment?.shipmentNumber ?? null,

    direction: row.direction,
    amount: toDecimalString(money(amount)),
    // Applied once, here, from the shared helper — so no screen and no payout
    // run can disagree about which way a DECREASE points.
    signedAmount: signedAdjustmentAmount({ direction: row.direction, amount }),

    reason: row.reason,

    approvedBy: row.approvedBy,
    approvedByName: row.approvedByUser?.name ?? null,
    approvedAt: row.approvedAt.toISOString(),

    payoutLineId: row.payoutLineId,
    isEditable: row.payoutLineId === null,

    ...auditFields(row),
  };
}
