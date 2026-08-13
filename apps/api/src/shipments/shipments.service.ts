import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@eztruckr/db';
import {
  allowedManualTransitions,
  areChargesEditable,
  CrewRole,
  hasBrokerForTpc,
  hasUnambiguousTpc,
  isAllowedManualTransition,
  isRateChainEditable,
  isShipmentStatus,
  LiquidationStatus,
  SAME_PERSON_BOTH_SLOTS_MESSAGE,
  SHIPMENT_STATUS_LABELS,
  ShipmentStatus,
  shipmentStatusAtLeast,
  statusAfterManualTransition,
  sum,
  toDecimalString,
  TPC_EXCLUSIVE_MESSAGE,
  TPC_WITHOUT_BROKER_MESSAGE,
  type AssignCrewInput,
  type CreateShipmentInput,
  type GasRateContext,
  type Page,
  type SetGasRateOverrideInput,
  type Shipment,
  type ShipmentListQuery,
  type TransitionShipmentInput,
  type UpdateShipmentInput,
} from '@eztruckr/types';
import { computeRateChain } from '../commission/commission-chain';
import { ensurePendingLiquidation } from '../liquidation/pending-liquidation';
import { PrismaService } from '../prisma/prisma.service';
import { auditFields, dateToIso, decimalToString } from '../master-data/serialize';

/**
 * Shipments: the rate chain, the crew, and the status lifecycle.
 *
 * Commission arithmetic is NOT here. This service owns what a shipment is and
 * what may be changed about it when; `CommissionService` owns what the crew
 * are paid. The line between them is the reason there is exactly one place in
 * the codebase that multiplies a base by a rate.
 */

const SHIPMENT_INCLUDE = {
  client: { select: { name: true } },
  thirdParty: { select: { name: true } },
  route: { select: { name: true } },
  truck: { select: { plateNumber: true } },
  driver: { select: { firstName: true, lastName: true } },
  helper: { select: { firstName: true, lastName: true } },
} satisfies Prisma.ShipmentInclude;

type ShipmentRow = Prisma.ShipmentGetPayload<{ include: typeof SHIPMENT_INCLUDE }>;

@Injectable()
export class ShipmentsService {
  constructor(private readonly prisma: PrismaService) {}

  private get shipments() {
    return this.prisma.client.shipment;
  }

  async list(query: ShipmentListQuery): Promise<Page<Shipment>> {
    const where: Prisma.ShipmentWhereInput = {
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.clientId ? { clientId: query.clientId } : {}),
      // One filter for "trips this person worked", either slot. The crew
      // portal relies on this, so it is scoped server-side by the controller.
      ...(query.crewMemberId
        ? { OR: [{ driverId: query.crewMemberId }, { helperId: query.crewMemberId }] }
        : {}),
      ...(query.search
        ? {
            OR: [
              { shipmentNumber: { contains: query.search, mode: 'insensitive' } },
              { origin: { contains: query.search, mode: 'insensitive' } },
              { destination: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.shipments.findMany({
        where,
        include: SHIPMENT_INCLUDE,
        orderBy: [{ createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.shipments.count({ where }),
    ]);

    return { items: rows.map(toShipment), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<Shipment> {
    const [row, commissionsStale, advances] = await Promise.all([
      this.load(id),
      this.isComputationStale(id),
      this.prisma.client.allowance.findMany({
        where: { shipmentId: id },
        select: { amount: true },
      }),
    ]);

    return {
      ...toShipment(row),
      commissionsStale,
      // Summed here rather than stored: the shipment has no allowance column
      // for a second release to overwrite, and that is the point.
      totalAdvanced: toDecimalString(sum(advances.map((row) => row.amount))),
    };
  }

  async create(input: CreateShipmentInput): Promise<Shipment> {
    await this.assertReferencesExist(input);

    const rates = computeRateChain({
      grossRate: input.grossRate,
      tpcRate: input.tpcRate,
      tpcAmount: input.tpcAmount,
    });

    this.assertNetRateIsSane(rates.netRate, rates.grossRate);

    const row = await this.shipments.create({
      data: {
        shipmentNumber: input.shipmentNumber,
        status: ShipmentStatus.DRAFT,
        clientId: input.clientId,
        thirdPartyId: input.thirdPartyId,
        routeId: input.routeId,
        truckId: input.truckId,
        origin: input.origin,
        destination: input.destination,
        cargoDescription: input.cargoDescription,
        grossRate: rates.grossRate,
        tpcAmount: rates.tpcAmount,
        netRate: rates.netRate,
        appliedTpcRate: rates.appliedTpcRate,
      },
      include: SHIPMENT_INCLUDE,
    });

    return toShipment(row);
  }

  /**
   * The rate chain is only editable in DRAFT.
   *
   * Once a shipment is dispatched the crew are on the road against an agreed
   * figure, and the gross rate has stopped being a proposal. Allowing an edit
   * after that would silently move the commission base of work already done.
   */
  async update(id: string, input: UpdateShipmentInput): Promise<Shipment> {
    const current = await this.load(id);
    const status = this.statusOf(current);

    if (!isRateChainEditable(status)) {
      throw new ConflictException(
        `Shipment ${current.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; its rate chain can only be changed while it is a draft.`,
      );
    }

    const merged = {
      thirdPartyId: input.thirdPartyId === undefined ? current.thirdPartyId : input.thirdPartyId,
      tpcRate:
        input.tpcRate === undefined ? decimalToString(current.appliedTpcRate) : input.tpcRate,
      tpcAmount: input.tpcAmount,
    };

    if (!hasUnambiguousTpc(merged)) {
      throw badRequest('tpcAmount', TPC_EXCLUSIVE_MESSAGE);
    }

    if (!hasBrokerForTpc(merged)) {
      throw badRequest('thirdPartyId', TPC_WITHOUT_BROKER_MESSAGE);
    }

    await this.assertReferencesExist(input);

    const data: Prisma.ShipmentUncheckedUpdateInput = {};

    if (input.shipmentNumber !== undefined) data.shipmentNumber = input.shipmentNumber;
    if (input.clientId !== undefined) data.clientId = input.clientId;
    if (input.thirdPartyId !== undefined) data.thirdPartyId = input.thirdPartyId;
    if (input.routeId !== undefined) data.routeId = input.routeId;
    if (input.truckId !== undefined) data.truckId = input.truckId;
    if (input.origin !== undefined) data.origin = input.origin;
    if (input.destination !== undefined) data.destination = input.destination;
    if (input.cargoDescription !== undefined) data.cargoDescription = input.cargoDescription;

    // Any touch of the rate inputs re-derives the whole chain, so gross, TPC
    // and net can never drift apart into three separately-edited numbers.
    const touchesRates =
      input.grossRate !== undefined || input.tpcRate !== undefined || input.tpcAmount !== undefined;

    if (touchesRates) {
      const rates = computeRateChain({
        grossRate: input.grossRate ?? current.grossRate.toString(),
        tpcRate: merged.tpcRate,
        tpcAmount:
          merged.tpcAmount ?? (merged.tpcRate === null ? current.tpcAmount.toString() : null),
      });

      this.assertNetRateIsSane(rates.netRate, rates.grossRate);

      data.grossRate = rates.grossRate;
      data.tpcAmount = rates.tpcAmount;
      data.netRate = rates.netRate;
      data.appliedTpcRate = rates.appliedTpcRate;
    }

    return toShipment(
      await this.shipments.update({ where: { id }, data, include: SHIPMENT_INCLUDE }),
    );
  }

  /**
   * Crew assignment, with the licence check the brief asks for.
   *
   * Both slots move together because they are one decision — assigning them
   * separately would let the same person briefly hold both, and the check for
   * that would have nothing to compare against.
   */
  async assignCrew(id: string, input: AssignCrewInput): Promise<Shipment> {
    const current = await this.load(id);
    const status = this.statusOf(current);

    if (shipmentStatusAtLeast(status, ShipmentStatus.LIQUIDATED)) {
      throw new ConflictException(
        `Shipment ${current.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; its crew can no longer be changed.`,
      );
    }

    // Paid, not merely computed: a recomputation can re-attach unpaid
    // commissions to the corrected crew, but a paid one names someone who has
    // already been handed the money.
    await this.assertNothingPaid(current, 'Changing the crew');

    if (input.driverId !== null && input.driverId === input.helperId) {
      throw badRequest('helperId', SAME_PERSON_BOTH_SLOTS_MESSAGE);
    }

    if (input.driverId) await this.assertEligible(input.driverId, CrewRole.DRIVER);
    if (input.helperId) await this.assertEligible(input.helperId, CrewRole.HELPER);

    return toShipment(
      await this.shipments.update({
        where: { id },
        data: { driverId: input.driverId, helperId: input.helperId },
        include: SHIPMENT_INCLUDE,
      }),
    );
  }

  /**
   * Moves the shipment along its lifecycle.
   *
   * DELIVERED is special: asking for it stores PENDING_LIQUIDATION, so a
   * delivered trip is immediately visible in queries as awaiting liquidation
   * rather than inferred from the absence of a liquidation row.
   */
  async transition(id: string, input: TransitionShipmentInput): Promise<Shipment> {
    const current = await this.load(id);
    const from = this.statusOf(current);

    if (!isAllowedManualTransition(from, input.to)) {
      const allowed = allowedManualTransitions(from)
        .map((status) => SHIPMENT_STATUS_LABELS[status])
        .join(', ');

      throw new ConflictException(
        allowed.length > 0
          ? `A ${SHIPMENT_STATUS_LABELS[from].toLowerCase()} shipment can only move to: ${allowed}.`
          : this.explainDeadEnd(from, current.shipmentNumber),
      );
    }

    const occurredAt = input.occurredAt === null ? new Date() : new Date(input.occurredAt);
    const stored = statusAfterManualTransition(input.to);
    const data: Prisma.ShipmentUncheckedUpdateInput = { status: stored };

    if (input.to === ShipmentStatus.DISPATCHED) {
      this.assertReadyToDispatch(current);
      data.dispatchedAt = occurredAt;
    }

    if (input.to === ShipmentStatus.DELIVERED) {
      data.deliveredAt = occurredAt;
    }

    if (input.to === ShipmentStatus.CLOSED) {
      await this.assertReadyToClose(current);
      data.closedAt = occurredAt;
    }

    const row = await this.prisma.client.$transaction(async (tx) => {
      const updated = await tx.shipment.update({ where: { id }, data, include: SHIPMENT_INCLUDE });

      // Delivery brings the liquidation into existence, in the same statement.
      // Before this, "the crew still owe us paperwork" was the ABSENCE of a
      // row, which no query can filter on and no crew portal can show. The
      // shipment lands in PENDING_LIQUIDATION here; its liquidation lands in
      // PENDING, and the two mean the same thing on purpose.
      if (input.to === ShipmentStatus.DELIVERED) {
        await ensurePendingLiquidation(tx, id);
      }

      return updated;
    });

    return toShipment(row);
  }

  /**
   * Records a per-shipment gas deduction rate, or clears it.
   *
   * Writes the INPUT column only. `appliedGasDeductionRate` is an output and
   * belongs to the engine — setting an override does not retroactively change
   * what an earlier computation used, and the shipment will report itself
   * stale until somebody recomputes.
   *
   * A null rate clears the override and the reason together; the schema
   * refuses either one alone, and a CHECK backs that up in the database.
   */
  async setGasRateOverride(id: string, input: SetGasRateOverrideInput): Promise<Shipment> {
    const current = await this.load(id);

    await this.assertNothingPaid(current, 'Changing the gas deduction rate');

    return toShipment(
      await this.shipments.update({
        where: { id },
        data: {
          gasRateOverride: input.rate,
          gasRateOverrideReason: input.reason,
        },
        include: SHIPMENT_INCLUDE,
      }),
    );
  }

  /**
   * The three rates that matter to this shipment, kept distinct.
   *
   * `effective` is what the next computation WILL use; `frozen` is what the
   * last one DID. They differ whenever the override changed after computing,
   * which is exactly the moment a screen needs to say so rather than showing
   * one number and hoping it is the right one.
   */
  async gasRateContext(id: string): Promise<GasRateContext> {
    const shipment = await this.load(id);
    const setting = await this.prisma.client.systemSetting.findFirst({
      where: { id: 'singleton' },
      select: { gasExpenseDeductionRate: true },
    });

    const systemDefault = setting?.gasExpenseDeductionRate.toString() ?? '0.2500';
    const override = decimalToString(shipment.gasRateOverride);

    return {
      systemDefault,
      override,
      reason: shipment.gasRateOverrideReason,
      isOverride: override !== null,
      effective: override ?? systemDefault,
      frozen: decimalToString(shipment.appliedGasDeductionRate),
    };
  }

  // -------------------------------------------------------------------------

  async load(id: string): Promise<ShipmentRow> {
    const row = await this.shipments.findFirst({ where: { id }, include: SHIPMENT_INCLUDE });

    if (!row) {
      throw new NotFoundException(`No shipment with id ${id}`);
    }

    return row;
  }

  statusOf(row: { id: string; status: number }): ShipmentStatus {
    if (!isShipmentStatus(row.status)) {
      throw new Error(`Shipment ${row.id} has an unrecognised status code ${row.status}`);
    }

    return row.status;
  }

  /** Charges stay open until the base is frozen. Used by the charge services. */
  async assertChargesEditable(shipmentId: string): Promise<ShipmentRow> {
    const shipment = await this.load(shipmentId);
    const status = this.statusOf(shipment);

    if (!areChargesEditable(status)) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; its charges are closed.`,
      );
    }

    await this.assertNothingPaid(shipment, 'Adding or changing a charge');

    return shipment;
  }

  /**
   * The line that actually matters for money already committed.
   *
   * Not "have commissions been computed" — that would be a dead end, since a
   * charge discovered late is precisely the thing a recomputation exists to
   * absorb, and locking charges at computation would leave the user unable to
   * fix the charge OR to make the recomputation say anything different. What
   * cannot move is a commission that has been PAID: the cash has left, and the
   * voucher behind it has to keep reconciling.
   *
   * A computed-but-unpaid commission goes stale instead of blocking, and
   * `commissionsStale` on the shipment says so, so the recompute is prompted
   * rather than silently needed.
   */
  private async assertNothingPaid(shipment: ShipmentRow, action: string): Promise<void> {
    const paid = await this.prisma.client.commission.count({
      where: { shipmentId: shipment.id, payoutLineId: { not: null } },
    });

    if (paid > 0) {
      throw new ConflictException(
        `${action} is not possible on shipment ${shipment.shipmentNumber}: ${paid} of its commissions have already been paid, and the figures behind a payout cannot move.`,
      );
    }
  }

  /**
   * True when the stored commission chain predates the charges it is supposed
   * to be derived from.
   *
   * Derived rather than stored: a `stale` column would be one more thing that
   * can be wrong, whereas comparing timestamps cannot disagree with the rows
   * it is comparing.
   */
  async isComputationStale(shipmentId: string): Promise<boolean> {
    const shipment = await this.load(shipmentId);

    if (shipment.commissionsComputedAt === null) {
      return false;
    }

    const computedAt = shipment.commissionsComputedAt;

    const [expense, charge] = await Promise.all([
      this.prisma.client.billableExpense.findFirst({
        where: { shipmentId, updatedAt: { gt: computedAt } },
        select: { id: true },
      }),
      this.prisma.client.additionalCharge.findFirst({
        where: { shipmentId, updatedAt: { gt: computedAt } },
        select: { id: true },
      }),
    ]);

    return expense !== null || charge !== null;
  }

  private explainDeadEnd(from: ShipmentStatus, shipmentNumber: string): string {
    if (from === ShipmentStatus.PENDING_LIQUIDATION) {
      return `Shipment ${shipmentNumber} is awaiting liquidation. It becomes liquidated on its own once the liquidation is approved and commissions are computed — that step is earned, not requested.`;
    }

    if (from === ShipmentStatus.CLOSED) {
      return `Shipment ${shipmentNumber} is closed. The workflow does not run backwards, because the frozen rates and computed commissions behind it have no defined behaviour in reverse.`;
    }

    return `Shipment ${shipmentNumber} cannot be moved from ${SHIPMENT_STATUS_LABELS[from].toLowerCase()}.`;
  }

  /**
   * Dispatch is the point of no return for the rate chain, so it is where the
   * shipment has to be complete: someone driving it, in something to drive.
   */
  private assertReadyToDispatch(shipment: ShipmentRow): void {
    if (!shipment.driverId) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has no driver assigned and cannot be dispatched.`,
      );
    }

    if (!shipment.truckId) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has no truck assigned and cannot be dispatched.`,
      );
    }
  }

  /**
   * The guard rail from the brief: a shipment cannot close until the allowance
   * is liquidated and commissions are computed.
   *
   * Reaching LIQUIDATED already required an approved liquidation, so by here
   * the first half is satisfied by the status itself. The commission check is
   * still made explicitly rather than assumed, because it is the half that
   * actually costs someone money if it is wrong.
   */
  private async assertReadyToClose(shipment: ShipmentRow): Promise<void> {
    if (shipment.commissionsComputedAt === null) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has no computed commissions, so closing it would strand the crew's pay.`,
      );
    }

    const advances = await this.prisma.client.allowance.count({
      where: { shipmentId: shipment.id },
    });

    if (advances === 0) {
      return;
    }

    // An allowance is a receivable from the crew, not a cost, and it is
    // cleared by the liquidation. Cash handed over and never accounted for is
    // exactly what closing a trip must not be able to hide.
    //
    // APPROVED is the only status that counts, and it is the last one: approval
    // is the lock, so there is nothing beyond it to also accept here.
    const settled = await this.prisma.client.liquidation.count({
      where: { shipmentId: shipment.id, status: LiquidationStatus.APPROVED },
    });

    if (settled === 0) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has ${advances} allowance(s) advanced to the crew and no approved liquidation. Cash advanced has to be accounted for before the trip can close.`,
      );
    }
  }

  /**
   * Role eligibility, and — for a driver slot only — a licence that exists and
   * has not expired. The licence columns are nullable precisely because they
   * are required at this moment and not before: a helper never needs one.
   */
  private async assertEligible(crewMemberId: string, role: CrewRole): Promise<void> {
    const crew = await this.prisma.client.crewMember.findFirst({
      where: { id: crewMemberId },
      select: {
        firstName: true,
        lastName: true,
        isActive: true,
        eligibleRoles: true,
        licenseNumber: true,
        licenseExpiry: true,
      },
    });

    const field = role === CrewRole.DRIVER ? 'driverId' : 'helperId';

    if (!crew) {
      throw badRequest(field, `No crew member with id ${crewMemberId}`);
    }

    const name = `${crew.firstName} ${crew.lastName}`;

    if (!crew.isActive) {
      throw badRequest(field, `${name} is deactivated and cannot be assigned to new work.`);
    }

    if (!crew.eligibleRoles.includes(role)) {
      throw badRequest(
        field,
        `${name} is not eligible to work as a ${role === CrewRole.DRIVER ? 'driver' : 'helper'}.`,
      );
    }

    if (role !== CrewRole.DRIVER) {
      return;
    }

    if (!crew.licenseNumber) {
      throw badRequest(field, `${name} has no licence number recorded and cannot drive.`);
    }

    if (!crew.licenseExpiry) {
      throw badRequest(field, `${name} has no licence expiry recorded and cannot drive.`);
    }

    if (crew.licenseExpiry.getTime() <= Date.now()) {
      throw badRequest(
        field,
        `${name}'s licence expired on ${crew.licenseExpiry.toISOString().slice(0, 10)} and cannot drive.`,
      );
    }
  }

  /**
   * A broker cut larger than the freight would make the net rate negative, and
   * every figure downstream — the commission base, the crew's pay — would
   * inherit the sign. Better to refuse the input than to compute on it.
   */
  private assertNetRateIsSane(netRate: string, grossRate: string): void {
    if (netRate.startsWith('-')) {
      throw badRequest(
        'tpcAmount',
        `The third-party commission is larger than the gross rate of ${grossRate}, which would make the net rate negative.`,
      );
    }
  }

  private async assertReferencesExist(
    input: Partial<Pick<CreateShipmentInput, 'clientId' | 'thirdPartyId' | 'routeId' | 'truckId'>>,
  ): Promise<void> {
    const checks: Array<[string, string | null | undefined, () => Promise<unknown>]> = [
      [
        'clientId',
        input.clientId,
        () => this.prisma.client.client.findFirst({ where: { id: input.clientId ?? '' } }),
      ],
      [
        'thirdPartyId',
        input.thirdPartyId,
        () => this.prisma.client.thirdParty.findFirst({ where: { id: input.thirdPartyId ?? '' } }),
      ],
      [
        'routeId',
        input.routeId,
        () => this.prisma.client.route.findFirst({ where: { id: input.routeId ?? '' } }),
      ],
      [
        'truckId',
        input.truckId,
        () => this.prisma.client.truck.findFirst({ where: { id: input.truckId ?? '' } }),
      ],
    ];

    for (const [field, value, lookup] of checks) {
      if (!value) continue;

      if (!(await lookup())) {
        throw badRequest(field, `No record with id ${value}`);
      }
    }
  }
}

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}

export function toShipment(row: ShipmentRow): Shipment {
  if (!isShipmentStatus(row.status)) {
    throw new Error(`Shipment ${row.id} has an unrecognised status code ${row.status}`);
  }

  return {
    id: row.id,
    shipmentNumber: row.shipmentNumber,
    status: row.status,

    clientId: row.clientId,
    clientName: row.client?.name ?? null,
    thirdPartyId: row.thirdPartyId,
    thirdPartyName: row.thirdParty?.name ?? null,
    routeId: row.routeId,
    routeName: row.route?.name ?? null,
    truckId: row.truckId,
    truckPlateNumber: row.truck?.plateNumber ?? null,

    origin: row.origin,
    destination: row.destination,
    cargoDescription: row.cargoDescription,

    driverId: row.driverId,
    driverName: row.driver ? `${row.driver.firstName} ${row.driver.lastName}` : null,
    helperId: row.helperId,
    helperName: row.helper ? `${row.helper.firstName} ${row.helper.lastName}` : null,

    dispatchedAt: dateToIso(row.dispatchedAt),
    deliveredAt: dateToIso(row.deliveredAt),
    closedAt: dateToIso(row.closedAt),

    grossRate: row.grossRate.toString(),
    tpcAmount: row.tpcAmount.toString(),
    netRate: row.netRate.toString(),
    appliedTpcRate: decimalToString(row.appliedTpcRate),

    gasRateOverride: decimalToString(row.gasRateOverride),
    gasRateOverrideReason: row.gasRateOverrideReason,
    appliedGasDeductionRate: decimalToString(row.appliedGasDeductionRate),
    commissionableCharges: decimalToString(row.commissionableCharges),
    grossForCommission: decimalToString(row.grossForCommission),
    gasDeductionAmount: decimalToString(row.gasDeductionAmount),
    commissionableBase: decimalToString(row.commissionableBase),
    commissionsComputedAt: dateToIso(row.commissionsComputedAt),
    // Costs two extra queries to answer, so the list leaves it false and the
    // detail endpoint overrides it. False here means "not checked", which is
    // the safe way round: it never claims freshness the server has verified.
    commissionsStale: false,
    // Likewise: one query per shipment, so the list leaves it at zero and the
    // detail endpoint answers it properly.
    totalAdvanced: '0.00',

    ...auditFields(row),
  };
}
