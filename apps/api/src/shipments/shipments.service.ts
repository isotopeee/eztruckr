import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, withDeleted } from '@eztruckr/db';
import {
  allowedManualTransitions,
  AllowanceRequestStatus,
  areBookingDetailsCorrectable,
  areChargesEditable,
  CrewRole,
  draftOnlyFieldsIn,
  hasBrokerForTpc,
  hasUnambiguousTpc,
  isAllowedManualTransition,
  isRateChainCorrectable,
  isRateChainEditable,
  isShipmentRemovableByDispatch,
  isShipmentStatus,
  liquidationAccountLabel,
  LiquidationStatus,
  nextShipmentNumber,
  SAME_PERSON_BOTH_SLOTS_MESSAGE,
  SHIPMENT_STATUS_LABELS,
  ShipmentStatus,
  shipmentNumberDatePart,
  shipmentStatusAtLeast,
  statusAfterManualTransition,
  sum,
  toDecimalString,
  TPC_EXCLUSIVE_MESSAGE,
  TPC_WITHOUT_BROKER_MESSAGE,
  type AssignCrewInput,
  type AssignTruckInput,
  type CreateShipmentInput,
  type GasRateContext,
  type Page,
  type SetGasRateOverrideInput,
  type Shipment,
  type ShipmentListQuery,
  type ShipmentSortField,
  type SortDirection,
  type TransitionShipmentInput,
  type UpdateRateChainInput,
  type UpdateShipmentInput,
  type UserRole,
} from '@eztruckr/types';
import { CAN_REMOVE_ANY_SHIPMENT } from '../auth/role-policy';
import type { RequestUser } from '../auth/request-user';
import { computeRateChain } from '../commission/commission-chain';
import {
  ensureAccountForCustodian,
  ensurePendingLiquidation,
} from '../liquidation/pending-liquidation';
import { PrismaService } from '../prisma/prisma.service';
import { collectReferences, type ReferenceProbe } from '../master-data/removal';
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

/**
 * The list's ordering, as Prisma clauses.
 *
 * SORTED IN THE DATABASE, not in the browser, because the list is paginated:
 * ordering the twenty-five rows already fetched would answer "the largest net
 * rate on this page", which is not a question anybody asks and is indeed the
 * bug that looks most like a working feature.
 *
 * STATUS ORDERS BY ITS NUMERIC CODE, which is the one clause here that needs
 * defending — `@eztruckr/types` is emphatic that workflow order comes from
 * SHIPMENT_STATUS_SEQUENCE and never from the value. It holds today only
 * because the codes happen to ascend with that sequence, and Prisma cannot
 * express "order by position in this list" without dropping the whole query to
 * raw SQL. So the coincidence is pinned by a test instead
 * (`shipment-status-sort.test.ts`): append a status that belongs mid-workflow
 * and it fails, which is the moment to write the CASE mapping rather than ship
 * a list that quietly sorts Closed before Draft.
 */
function orderFor(
  sort: ShipmentSortField,
  direction: SortDirection,
): Prisma.ShipmentOrderByWithRelationInput[] {
  // Trips with no container number are the ones the sort has nothing to say
  // about, so they go last whichever way it runs rather than filling the top
  // of a descending list with blanks.
  const blanksLast = { sort: direction, nulls: 'last' } as const;

  const column: Record<ShipmentSortField, Prisma.ShipmentOrderByWithRelationInput> = {
    date: { shipmentDate: direction },
    number: { shipmentNumber: direction },
    // Through the relation: the stored column is a foreign key, which sorts by
    // nothing a reader recognises.
    client: { client: { name: direction } },
    container: { containerNumber: blanksLast },
    netRate: { netRate: direction },
    status: { status: direction },
  };

  // Ties broken on the id, which is a uuidv7 — unique, and minted in creation
  // order. Without it two trips sharing a date could swap places between one
  // page request and the next, so a row would appear twice or not at all.
  return [column[sort], { id: 'desc' }];
}

/**
 * How many times a booking will recompute its number before giving up.
 *
 * Each retry costs one round trip and only happens when two bookings land in
 * the same instant, so the ceiling is about bounding a pathological loop rather
 * than about contention: reaching it would mean five consecutive collisions,
 * which is a signal worth surfacing rather than retrying through.
 */
const SHIPMENT_NUMBER_ATTEMPTS = 5;

/**
 * A racing booking took the number this one had computed.
 *
 * Narrowed to the shipment-number index specifically. A blanket "was it P2002"
 * would also swallow a genuine duplicate somewhere else in the same statement
 * and retry it forever with the same outcome.
 */
function isShipmentNumberCollision(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }

  // BOTH SPELLINGS, because which one arrives is not ours to decide. The
  // constraint is a raw partial index named `shipment_number_live_key`, but
  // Prisma resolves it back to the model field and reports `shipmentNumber` —
  // and it is the client's business, not this code's, if that ever changes.
  // Matching only the index name silently turned every retry into a 500.
  const detail = `${JSON.stringify(error.meta?.target ?? '')} ${error.message}`;

  return detail.includes('shipmentNumber') || detail.includes('shipment_number');
}

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
      ...(query.staffId ? { OR: [{ driverId: query.staffId }, { helperId: query.staffId }] } : {}),
      ...(query.search
        ? {
            OR: [
              { shipmentNumber: { contains: query.search, mode: 'insensitive' } },
              { origin: { contains: query.search, mode: 'insensitive' } },
              { destination: { contains: query.search, mode: 'insensitive' } },
              // The container number is what a client phones up quoting, so it
              // is searched exactly like the shipment number rather than being
              // a filter of its own.
              { containerNumber: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.shipments.findMany({
        where,
        include: SHIPMENT_INCLUDE,
        orderBy: orderFor(query.sort, query.direction),
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

  /**
   * Books a trip, and generates its number.
   *
   * The NUMBER is generated rather than typed — see `shipment-number.ts` for
   * the format and why the date is Manila's. Two people booking at the same
   * moment can compute the same next number, so the partial unique index is
   * the arbiter and a collision is retried rather than reported: the second
   * booker did nothing wrong and should not be shown a constraint name.
   *
   * NO LIQUIDATION IS OPENED HERE, and it used to be. Booking created one with
   * nobody named to it, on the reasoning that a trip starts spending before the
   * office closes it out — true, but the row it produced was an ACCOUNT WITH NO
   * CUSTODIAN, and that is a different thing from a place to record spending.
   * Every trip carried one whether or not anybody ever held its cash; releases
   * landed on it by default, which is how a helper's ferry money ended up on a
   * row that later became the driver's; and an empty unnamed account sat on
   * every draft in the system.
   *
   * An account now arrives when somebody is answerable for one: named to a
   * helper by `assignCrew`, opened by hand for anybody else, and — for a trip
   * that reached delivery with none at all — created unnamed by the backstop in
   * `transition`, which is the one case where the crew genuinely have paperwork
   * and nowhere to put it.
   */
  async create(input: CreateShipmentInput): Promise<Shipment> {
    await this.assertReferencesExist(input);

    const rates = computeRateChain({
      grossRate: input.grossRate,
      tpcRate: input.tpcRate,
      tpcAmount: input.tpcAmount,
    });

    this.assertNetRateIsSane(rates.netRate, rates.grossRate);

    const data = {
      status: ShipmentStatus.DRAFT,
      clientId: input.clientId,
      thirdPartyId: input.thirdPartyId,
      routeId: input.routeId,
      truckId: input.truckId,
      // Omitted rather than passed as null, so the column's own default stands:
      // a booking that says nothing about the date is one made today.
      ...(input.shipmentDate === null ? {} : { shipmentDate: new Date(input.shipmentDate) }),
      origin: input.origin,
      destination: input.destination,
      cargoDescription: input.cargoDescription,
      containerNumber: input.containerNumber,
      grossRate: rates.grossRate,
      tpcAmount: rates.tpcAmount,
      netRate: rates.netRate,
      appliedTpcRate: rates.appliedTpcRate,
    };

    for (let attempt = 1; ; attempt += 1) {
      const shipmentNumber = await this.generateShipmentNumber();

      try {
        // A plain create, no longer a transaction: the transaction existed to
        // land the shipment and its liquidation together, and there is no
        // second row to land any more.
        const row = await this.shipments.create({
          data: { ...data, shipmentNumber },
          include: SHIPMENT_INCLUDE,
        });

        return toShipment(row);
      } catch (error) {
        if (attempt >= SHIPMENT_NUMBER_ATTEMPTS || !isShipmentNumberCollision(error)) {
          throw error;
        }
      }
    }
  }

  /**
   * The next number for today, in the company's own timezone.
   *
   * Scans SOFT-DELETED rows too. A number that has been issued is spent: the
   * trip it belonged to may have been removed here, but not from whatever
   * paperwork left the building first, and two trips behind one label is worse
   * than a gap in the sequence.
   */
  private async generateShipmentNumber(): Promise<string> {
    const datePart = shipmentNumberDatePart(new Date());

    const issued = await withDeleted(async () =>
      this.shipments.findMany({
        where: { shipmentNumber: { startsWith: datePart } },
        select: { shipmentNumber: true },
      }),
    );

    return nextShipmentNumber(
      datePart,
      issued.map((row) => row.shipmentNumber),
    );
  }

  /**
   * The booking edit, which is really two edits under one route.
   *
   * THE RATE CHAIN AND WHAT WAS CARRIED still shut at DRAFT: once a shipment
   * is dispatched the crew are on the road against an agreed figure, and the
   * gross rate has stopped being a proposal. Allowing an edit after that would
   * silently move the commission base of work already done.
   *
   * THE FACTS THAT IDENTIFY THE TRIP do not — client, date, route, lane and
   * container number stay correctable until LIQUIDATED, because they are
   * transcription of paperwork that arrives after the booking rather than terms
   * anybody committed to. See `areBookingDetailsCorrectable` for why that is a
   * third rule rather than a relaxation of the first.
   *
   * SPLIT BY BODY HERE, not by route, and the difference from `updateRateChain`
   * is deliberate: that one is split by route because it carries a NARROWER
   * ROLE LIST, and `RolesGuard` cannot read a payload. Both halves of this one
   * are `CAN_WRITE_SHIPMENTS`, so there is no decision the guard needs to see
   * and a second endpoint would only duplicate every field on this one.
   */
  async update(id: string, input: UpdateShipmentInput): Promise<Shipment> {
    const current = await this.load(id);
    const status = this.statusOf(current);

    if (!areBookingDetailsCorrectable(status)) {
      throw new ConflictException(
        `Shipment ${current.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; its booking is part of the settled record.`,
      );
    }

    const draftOnly = draftOnlyFieldsIn(input);

    if (draftOnly.length > 0 && !isRateChainEditable(status)) {
      throw new ConflictException(
        `Shipment ${current.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; ${draftOnly.join(', ')} can only be changed while it is a draft. Its client, date, route, lane and container number are still correctable, and the rate chain has a correction of its own.`,
      );
    }

    /**
     * The client and the route are not just labels: `resolveCommissionRule`
     * scopes rules by both, so moving either can hand the crew a different
     * rate. Compared against what is stored rather than merely present, so
     * re-saving an unchanged form is not treated as a change.
     */
    const ruleScopeMoves =
      (input.clientId !== undefined && input.clientId !== current.clientId) ||
      (input.routeId !== undefined && input.routeId !== current.routeId);

    if (ruleScopeMoves) {
      await this.assertNothingPaid(current, 'Changing the client or the route');
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

    // No `shipmentNumber` here, and none in the schema either: it is generated
    // at creation, and a generated identifier anybody can overwrite carries
    // none of the guarantees that made generating it worthwhile.
    if (input.clientId !== undefined) data.clientId = input.clientId;
    if (input.thirdPartyId !== undefined) data.thirdPartyId = input.thirdPartyId;
    if (input.routeId !== undefined) data.routeId = input.routeId;
    if (input.truckId !== undefined) data.truckId = input.truckId;
    if (input.origin !== undefined) data.origin = input.origin;
    if (input.destination !== undefined) data.destination = input.destination;
    if (input.cargoDescription !== undefined) data.cargoDescription = input.cargoDescription;
    if (input.containerNumber !== undefined) data.containerNumber = input.containerNumber;
    // Null is "the schema normalised an absent date", not "clear the date" —
    // the column is NOT NULL, so there is nothing to clear it to.
    if (input.shipmentDate) data.shipmentDate = new Date(input.shipmentDate);

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

    /**
     * A moved rule scope goes through the same staleness channel a corrected
     * gross does, and for the same reason: the stored commissions were resolved
     * against the old client or route and no longer follow from the shipment
     * beside them. The column is named for the rate chain because that was the
     * only thing that could move it; what it actually records is the instant
     * the commission INPUTS last changed, which this is. The shipment's own
     * `updatedAt` still cannot stand in — correcting a container number moves
     * that, and must not report anybody's pay stale.
     */
    if (ruleScopeMoves) {
      data.rateChainUpdatedAt = new Date();
    }

    return toShipment(
      await this.shipments.update({ where: { id }, data, include: SHIPMENT_INCLUDE }),
    );
  }

  /**
   * Correcting the gross rate or the broker cut after the trip has left DRAFT.
   *
   * SEPARATE FROM `update` because the rule is different in both directions,
   * and collapsing them would break one of the two. `update` is the booking
   * form: every dispatcher may use it, and it closes at DRAFT because origin,
   * cargo and route describe a trip that has not left yet. This is a correction
   * to a figure that was agreed and recorded wrong, it belongs to
   * `CAN_EDIT_RATE_CHAIN`, and it stays open far longer.
   *
   * WHAT ACTUALLY STOPS IT is not the status, it is `assertNothingPaid` — the
   * same line that governs a late charge, for the same reason. A commission
   * computed but not paid goes STALE and is recomputed; a commission that has
   * been paid names a voucher that has to keep reconciling, and no correction is
   * worth rewriting that. The status bound on top of it exists because
   * LIQUIDATED means every account was approved against these figures.
   *
   * `rateChainUpdatedAt` is stamped here and nowhere else. Without it a
   * correction after a computation would leave the commissions quietly wrong
   * rather than reported stale — the shipment's own `updatedAt` cannot stand in,
   * because swapping a truck moves it too.
   */
  async updateRateChain(id: string, input: UpdateRateChainInput): Promise<Shipment> {
    const current = await this.load(id);
    const status = this.statusOf(current);

    if (!isRateChainCorrectable(status)) {
      throw new ConflictException(
        `Shipment ${current.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; its rate chain is part of the settled record.`,
      );
    }

    await this.assertNothingPaid(current, 'Correcting the rate chain');

    // THE BROKER AND THE CUT MOVE TOGETHER. A cut belongs to the broker it was
    // agreed with, so a swap has to restate it rather than inherit it — the
    // previous broker's ₱5,000 is not this one's, and carrying it over is
    // exactly the kind of invented number this codebase refuses. Clearing the
    // broker needs no restatement: there is nobody left to owe a share to.
    const thirdPartyId =
      input.thirdPartyId === undefined ? current.thirdPartyId : input.thirdPartyId;
    const brokerChanged = thirdPartyId !== current.thirdPartyId;
    const cutRestated = input.tpcRate !== undefined || input.tpcAmount !== undefined;

    if (brokerChanged && thirdPartyId !== null && !cutRestated) {
      throw badRequest(
        'tpcRate',
        'name the cut agreed with the third party you are naming — the previous one’s is not theirs',
      );
    }

    // Which of the two columns carries the deal is what `appliedTpcRate`
    // records: set for a percentage, null for a flat peso figure.
    //
    // A DIRECT CLIENT KEEPS NEITHER, and reading the stored `tpcAmount` back
    // for one is the trap here: it is 0, not null, so carrying it forward turns
    // "no broker, no cut" into "a cut of zero pesos owed to nobody" and the
    // broker check refuses a correction that only touched the gross.
    const agreedRate = decimalToString(current.appliedTpcRate);
    const carriesACut = thirdPartyId !== null;
    const cut = cutRestated
      ? { tpcRate: input.tpcRate ?? null, tpcAmount: input.tpcAmount ?? null }
      : brokerChanged || !carriesACut
        ? { tpcRate: null, tpcAmount: null }
        : {
            tpcRate: agreedRate,
            tpcAmount: agreedRate === null ? current.tpcAmount.toString() : null,
          };

    const merged = { thirdPartyId, ...cut };

    if (!hasUnambiguousTpc(merged)) {
      throw badRequest('tpcAmount', TPC_EXCLUSIVE_MESSAGE);
    }

    if (!hasBrokerForTpc(merged)) {
      throw badRequest('thirdPartyId', TPC_WITHOUT_BROKER_MESSAGE);
    }

    await this.assertReferencesExist({ thirdPartyId: input.thirdPartyId });

    const rates = computeRateChain({
      grossRate: input.grossRate ?? current.grossRate.toString(),
      tpcRate: merged.tpcRate,
      tpcAmount: merged.tpcAmount,
    });

    this.assertNetRateIsSane(rates.netRate, rates.grossRate);

    return toShipment(
      await this.shipments.update({
        where: { id },
        data: {
          thirdPartyId,
          grossRate: rates.grossRate,
          tpcAmount: rates.tpcAmount,
          netRate: rates.netRate,
          appliedTpcRate: rates.appliedTpcRate,
          rateChainUpdatedAt: new Date(),
        },
        include: SHIPMENT_INCLUDE,
      }),
    );
  }

  /**
   * Crew assignment, with the licence check the brief asks for.
   *
   * Both slots move together because they are one decision — assigning them
   * separately would let the same person briefly hold both, and the check for
   * that would have nothing to compare against.
   *
   * NAMING A HELPER OPENS THEIR CASH ACCOUNT, in the same transaction. The trip
   * is booked with one account that nobody is named to, and it becomes the
   * driver's; a helper handed ferry money at the pier had nowhere to put it
   * until an office user noticed and opened one by hand, so it went onto the
   * driver's account instead — the two people's money blended again in the one
   * place the schema was rebuilt to keep apart. See `ensureAccountForCustodian`
   * for why it ensures rather than opens, and why swapping a helper never
   * closes the outgoing one.
   *
   * THE DRIVER GETS NOTHING HERE, deliberately, and the asymmetry is the
   * point rather than an oversight. A helper's cash is the case that had
   * nowhere to go: the driver is who an office user names when they open or
   * claim the trip's account, so a driver's float has always had a home, and
   * opening one automatically beside a hand-made one would give the trip two
   * accounts where the cash is one pile.
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
      await this.prisma.client.$transaction(async (tx) => {
        const updated = await tx.shipment.update({
          where: { id },
          data: { driverId: input.driverId, helperId: input.helperId },
          include: SHIPMENT_INCLUDE,
        });

        // Inside the write, so a helper on the trip and an account for them are
        // one fact rather than two that can disagree. Nothing to do when the
        // slot is being cleared: the account of whoever was in it stays.
        if (input.helperId !== null) {
          await ensureAccountForCustodian(tx, id, input.helperId);
        }

        return updated;
      }),
    );
  }

  /**
   * Assigns the truck, or clears it.
   *
   * THE RULE IS DELIBERATELY LOOSER THAN THE CREW'S, and the difference is the
   * money. A crew member cannot be swapped once a commission has been paid,
   * because the voucher names them. A truck is paid nothing and appears nowhere
   * in the commission chain, so the only thing that should stop the record
   * being corrected is the trip being closed for good — and a truck that broke
   * down and was swapped at a roadside is exactly the correction this has to
   * allow. Reaching for `assertNothingPaid` here would be copying a guard
   * without its reason.
   *
   * Clearing is refused once the trip has been dispatched: a shipment on the
   * road with no truck against it is not a state anybody can act on, and
   * dispatch already asserted there was one.
   */
  async assignTruck(id: string, input: AssignTruckInput): Promise<Shipment> {
    const current = await this.load(id);
    const status = this.statusOf(current);

    if (status === ShipmentStatus.CLOSED) {
      throw new ConflictException(
        `Shipment ${current.shipmentNumber} is closed; the truck on it is now part of the record.`,
      );
    }

    if (input.truckId === null && shipmentStatusAtLeast(status, ShipmentStatus.DISPATCHED)) {
      throw badRequest(
        'truckId',
        `Shipment ${current.shipmentNumber} has already been dispatched, so it cannot be left without a truck. Assign a different one instead.`,
      );
    }

    if (input.truckId !== null) {
      await this.assertTruckAssignable(input.truckId, current.truckId);
    }

    return toShipment(
      await this.shipments.update({
        where: { id },
        data: { truckId: input.truckId },
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

      // THE LAST RESORT, and on most trips it does nothing. A trip reaching
      // delivery has usually been given accounts already — named to the helper
      // when the crew were assigned, opened by hand for whoever else held cash
      // — and this call finds one and returns. What it catches is the trip that
      // got here with NONE: the crew have receipts in their hands and nowhere
      // to file them, and an unnamed account somebody can be named to beats
      // refusing the paperwork. Booking deliberately opens nothing, so this is
      // the only automatic unnamed account left in the system.
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
   * Removes a trip: dispatch undoing a booking, or an administrator taking one
   * out of the record.
   *
   * TWO PATHS THROUGH ONE ENDPOINT, and the difference is not how much role
   * somebody has — it is what the removal MEANS. Before dispatch the trip never
   * happened, so removing it is the booking form's undo and belongs to whoever
   * may book one; after it the trip ran, so removing it is an intervention in
   * the record and belongs to the administrator alone. The guard cannot tell
   * them apart because it cannot see the shipment's status, which is why the
   * decision is made here — the same shape as the transition map and the client
   * payment's verification check.
   *
   * A SOFT DELETE EITHER WAY: the row stays, stamped with who removed it and
   * when, and disappears from every list because the client extension filters
   * it. Nothing in this codebase destroys a business row, and a trip is not the
   * place to start.
   *
   * DISPATCH IS BOUNDED BY THE ROWS AS WELL AS THE STATUS, and the second bound
   * is the one that does the work — the same shape as `assertNothingPaid` on
   * the edits above. A draft can already carry released
   * cash, a client's deposit, a rebilled expense or an adjustment to somebody's
   * pay — every one a row that means something on its own — so the probes refuse
   * and name what is in the way. A dispatcher who genuinely needs that trip gone
   * asks an administrator, which is the path below.
   *
   * THE ADMINISTRATOR'S PATH CASCADES rather than refuses, because past DRAFT
   * refusing on the rows would refuse every trip: a delivered trip always has
   * charges, an account, a commission. So the trip's dependants go with it, in
   * one transaction — and that is exactly why this path is one role wide.
   *
   * WHAT NO ROLE CROSSES is money that has actually moved. `assertNothingMoved`
   * refuses a trip whose commission or adjustment has been paid, or whose crew
   * deduction has been recovered from a payout: the vouchers behind those have
   * to keep reconciling, and unlike everything else here that is not a decision
   * about tidiness. The database says the same thing from underneath — see
   * `paid_commission_no_soft_delete` — and this refuses first so the answer is a
   * sentence rather than a constraint name.
   */
  async remove(id: string, actor: RequestUser): Promise<{ removed: true }> {
    const current = await this.load(id);
    const status = this.statusOf(current);
    const mayRemoveAnything = (CAN_REMOVE_ANY_SHIPMENT as readonly UserRole[]).includes(actor.role);

    if (!mayRemoveAnything) {
      if (!isShipmentRemovableByDispatch(status)) {
        throw new ForbiddenException(
          `Shipment ${current.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; the trip has left the yard, so removing it now takes its charges, payments and cash accounts with it. An administrator can do that — your role can remove a booking that is still a draft.`,
        );
      }

      const references = await collectReferences(this.removalProbes(id));

      if (references.length > 0) {
        const found = references
          .map((reference) => `${reference.count} ${reference.entity}`)
          .join(', ');

        throw new ConflictException(
          `Shipment ${current.shipmentNumber} has ${found} recorded against it, so it is a trip that has started rather than a booking made in error. Remove those first if they were mistakes too, or ask an administrator to remove the trip.`,
        );
      }
    }

    await this.assertNothingMoved(current);

    await this.softDeleteWithDependants(id);

    return { removed: true };
  }

  /**
   * The trip and everything hanging off it, in one transaction.
   *
   * CHILDREN FIRST, PARENTS AFTER, which buys nothing from the foreign keys —
   * a soft delete is an UPDATE, so no constraint fires either way — and
   * everything from a failure landing halfway: stopping short leaves a trip
   * standing with some of its rows removed, which somebody can look at and
   * unpick, rather than a removed trip whose live charges are still being
   * counted by the P&L.
   *
   * EVERY LIST HERE IS READ DIRECTLY BY SOMETHING. A liquidation account
   * appears in accounting's queue, a client payment in the verification queue,
   * an unpaid commission in the next payout run — none of them reached through
   * the shipment, so none of them filtered by its removal. Leaving one behind
   * would not be untidy, it would be a queue entry pointing at a trip that no
   * longer exists.
   *
   * ON A DRAFT REMOVED BY DISPATCH almost all of it is a no-op: the probes have
   * already established there is nothing to find, and only the empty cash
   * account a helper's assignment opens is actually removed. That account is
   * why the cascade cannot be skipped for drafts — refusing on it would make
   * any trip with a helper on it permanently unremovable.
   */
  private async softDeleteWithDependants(shipmentId: string): Promise<void> {
    await this.prisma.client.$transaction(async (tx) => {
      const accounts = await tx.liquidation.findMany({
        where: { shipmentId },
        select: { id: true },
      });
      const liquidationId = { in: accounts.map((account) => account.id) };

      // The settlement's half: what came back, and any debt carried out of it.
      // The deduction goes with the settlement that created it rather than
      // becoming a free-floating balance nobody can explain — the same pairing
      // `LiquidationService.reverse` makes.
      await tx.crewDeduction.softDelete({ shipmentId });
      await tx.settlement.softDelete({ shipmentId });

      // Crew pay. Both are unpaid by `assertNothingMoved`, so neither names a
      // voucher; a recomputation soft-deletes commissions in exactly this way.
      await tx.commission.softDelete({ shipmentId });
      await tx.adjustment.softDelete({ shipmentId });

      // The accounts' contents, then the accounts.
      await tx.liquidationLine.softDelete({ liquidationId });
      await tx.liquidationHistory.softDelete({ liquidationId });
      await tx.allowance.softDelete({ shipmentId });
      await tx.allowanceRequest.softDelete({ shipmentId });
      await tx.liquidation.softDelete({ shipmentId });

      // The trip's own money, on both sides of the P&L.
      await tx.billableExpense.softDelete({ shipmentId });
      await tx.additionalCharge.softDelete({ shipmentId });
      await tx.companyPaidExpense.softDelete({ shipmentId });
      await tx.clientPayment.softDelete({ shipmentId });

      await tx.shipment.softDelete({ id: shipmentId });
    });
  }

  /**
   * The one refusal no role gets past: cash that has left the building.
   *
   * THREE FACTS, NOT ONE, and they are three because the money leaves by three
   * routes. A commission or an adjustment linked to a payout line is on a
   * voucher somebody has been handed; a recovered crew deduction is a slice
   * already taken out of a later payout. Removing the trip under any of them
   * would leave a voucher naming work the system says never happened.
   *
   * `assertNothingPaid` covers the commissions and is reused rather than
   * restated, so the line that governs a late correction is literally the same
   * line that governs this.
   */
  private async assertNothingMoved(shipment: ShipmentRow): Promise<void> {
    await this.assertNothingPaid(shipment, 'Removing the shipment');

    const [paidAdjustments, recovered] = await Promise.all([
      this.prisma.client.adjustment.count({
        where: { shipmentId: shipment.id, payoutLineId: { not: null } },
      }),
      this.prisma.client.crewDeductionRecovery.count({
        where: { crewDeduction: { shipmentId: shipment.id } },
      }),
    ]);

    if (paidAdjustments > 0) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} cannot be removed: ${paidAdjustments} of its pay adjustments have already been paid, and the figures behind a payout cannot move.`,
      );
    }

    if (recovered > 0) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} cannot be removed: a variance from it is being recovered from the crew's pay and ${recovered} slice(s) have already been taken.`,
      );
    }
  }

  /**
   * Everything that would make a trip more than a typing mistake.
   *
   * ONLY EVER ASKED ABOUT A DRAFT, because only dispatch's path consults them —
   * the administrator's cascades instead. That is what makes the omissions
   * below safe rather than lucky.
   *
   * COMMISSIONS, SETTLEMENTS AND CREW DEDUCTIONS ARE DELIBERATELY ABSENT.
   * None can exist before PENDING_LIQUIDATION — computing is refused below it,
   * and the other two are made out of an approved liquidation — so on a DRAFT
   * they would be three counts that can only ever return zero. If dispatch is
   * ever let past DRAFT, they are the probes to add, and this comment is where
   * to look.
   *
   * Named the way the screens name them, because the refusal is read by
   * whoever pressed the button.
   */
  private removalProbes(shipmentId: string): readonly ReferenceProbe[] {
    const db = this.prisma.client;

    return [
      {
        entity: 'billable expense(s)',
        count: () => db.billableExpense.count({ where: { shipmentId } }),
      },
      {
        entity: 'additional charge(s)',
        count: () => db.additionalCharge.count({ where: { shipmentId } }),
      },
      {
        entity: 'company-paid expense(s)',
        count: () => db.companyPaidExpense.count({ where: { shipmentId } }),
      },
      {
        entity: 'client payment(s)',
        count: () => db.clientPayment.count({ where: { shipmentId } }),
      },
      {
        entity: 'cash release(s)',
        count: () => db.allowance.count({ where: { shipmentId } }),
      },
      {
        entity: 'allowance request(s)',
        count: () => db.allowanceRequest.count({ where: { shipmentId } }),
      },
      {
        // Through the account rather than the trip, because a line names the
        // account it was claimed against and nothing else. The line's own
        // `deletedAt` is filtered by the extension; the account's cannot be,
        // and does not need to be — an account is refused removal while it
        // still has lines, so a live line under a removed one cannot arise.
        entity: 'claimed expense(s)',
        count: () => db.liquidationLine.count({ where: { liquidation: { shipmentId } } }),
      },
      {
        entity: 'pay adjustment(s)',
        count: () => db.adjustment.count({ where: { shipmentId } }),
      },
    ];
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

  /**
   * Charges stay open until the trip closes, and are refused outright once a
   * commission has been paid. Used by the charge services.
   */
  async assertChargesEditable(shipmentId: string): Promise<ShipmentRow> {
    const shipment = await this.load(shipmentId);
    const status = this.statusOf(shipment);

    if (!areChargesEditable(status)) {
      // Interpolated rather than written out, because the predicate names the
      // statuses and this should not hold a second opinion about which they
      // are. Today it can only read "closed".
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} is ${SHIPMENT_STATUS_LABELS[status].toLowerCase()}; its charges are now part of the record.`,
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
   * True when the stored commission chain predates the figures it is supposed
   * to be derived from.
   *
   * Derived rather than stored: a `stale` column would be one more thing that
   * can be wrong, whereas comparing timestamps cannot disagree with the rows
   * it is comparing.
   *
   * THE RATE CHAIN COUNTS TOO, and did not have to until it became correctable
   * — it was frozen at dispatch, so no computation could fall behind it. A
   * corrected gross moves the base for every crew member on the trip, which is
   * precisely what this flag exists to announce. A corrected CLIENT OR ROUTE
   * stamps the same column, because it re-scopes which commission rule applies
   * and so falsifies a computation just as thoroughly.
   */
  async isComputationStale(shipmentId: string): Promise<boolean> {
    const shipment = await this.load(shipmentId);

    if (shipment.commissionsComputedAt === null) {
      return false;
    }

    const computedAt = shipment.commissionsComputedAt;

    if (shipment.rateChainUpdatedAt !== null && shipment.rateChainUpdatedAt > computedAt) {
      return true;
    }

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

    // BEFORE THE EARLY RETURN BELOW, because a trip can carry an undecided ask
    // and no advances at all — which is exactly the case that would slip
    // through. Closing on top of one strands it in accounting's queue forever:
    // approving it afterwards is refused by the closed shipment, and nothing
    // else clears it. Deciding is one click, and declining is a decision.
    const undecided = await this.prisma.client.allowanceRequest.count({
      where: { shipmentId: shipment.id, status: AllowanceRequestStatus.PENDING },
    });

    if (undecided > 0) {
      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has ${undecided} allowance request(s) still awaiting accounting. Approve or decline them before closing the trip — a closed trip can no longer release cash, so the ask could never be answered.`,
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
    // EVERY ACCOUNT, not any one of them. This counted approvals and passed on
    // one, which was the same test while a trip could only have one — with a
    // driver and a helper each holding cash it would close the trip on the
    // driver's paperwork alone, stranding the helper's advance in a shipment
    // nothing can reopen.
    //
    // APPROVED is the only status that counts, and it is the last one: approval
    // is the lock, so there is nothing beyond it to also accept here.
    const outstanding = await this.prisma.client.liquidation.findMany({
      where: { shipmentId: shipment.id, status: { not: LiquidationStatus.APPROVED } },
      select: { sequence: true, custodian: { select: { firstName: true, lastName: true } } },
      orderBy: { sequence: 'asc' },
    });

    if (outstanding.length > 0) {
      // Named the way the screens name them. One person may hold several
      // accounts on a trip, so a list of names alone could read "Test Driver,
      // Test Driver" and leave the reader to work out which of the two is still
      // open.
      const who = outstanding
        .map((row) =>
          liquidationAccountLabel(
            row.custodian ? `${row.custodian.firstName} ${row.custodian.lastName}` : null,
            row.sequence,
          ),
        )
        .join(', ');

      throw new ConflictException(
        `Shipment ${shipment.shipmentNumber} has ${advances} allowance(s) advanced to the crew and ${outstanding.length} unapproved liquidation(s) — ${who}. Cash advanced has to be accounted for before the trip can close.`,
      );
    }
  }

  /**
   * Role eligibility, and — for a driver slot only — a licence that exists and
   * has not expired. The licence columns are nullable precisely because they
   * are required at this moment and not before: a helper never needs one.
   */
  private async assertEligible(staffId: string, role: CrewRole): Promise<void> {
    const crew = await this.prisma.client.staff.findFirst({
      where: { id: staffId },
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
      throw badRequest(field, `No crew member with id ${staffId}`);
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
   * The truck exists, and is not one that has been retired from service.
   *
   * `isActive` is checked only when the truck is CHANGING. A shipment already
   * carrying a truck that was sold last month must stay saveable — the same
   * separation of `isActive` from `deletedAt` the schema insists on everywhere
   * else: not offered for new work, still valid on history.
   */
  private async assertTruckAssignable(
    truckId: string,
    currentTruckId: string | null,
  ): Promise<void> {
    const truck = await this.prisma.client.truck.findFirst({
      where: { id: truckId },
      select: { plateNumber: true, isActive: true },
    });

    if (!truck) {
      throw badRequest('truckId', `No truck with id ${truckId}`);
    }

    if (!truck.isActive && truckId !== currentTruckId) {
      throw badRequest(
        'truckId',
        `${truck.plateNumber} is deactivated and cannot be assigned to new work.`,
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

    shipmentDate: row.shipmentDate.toISOString(),

    origin: row.origin,
    destination: row.destination,
    cargoDescription: row.cargoDescription,
    containerNumber: row.containerNumber,

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
