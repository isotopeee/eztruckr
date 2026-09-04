import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  SHIPMENT_STATUS_LABELS,
  UserRole,
  type CommissionComputation,
  type Commission,
  type CrewPayLine,
  type GrossProfit,
  type Page,
  type Shipment,
  type ShipmentSortField,
} from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_EDIT_RATE_CHAIN,
  CAN_READ_SHIPMENTS,
  CAN_REMOVE_ANY_SHIPMENT,
  CAN_REMOVE_DRAFT_SHIPMENTS,
  CAN_TRANSITION_SHIPMENTS,
  CAN_WRITE_SHIPMENT_MONEY,
  CAN_WRITE_SHIPMENTS,
  ROLES_BY_TRANSITION,
} from '../auth/role-policy';
import { AdjustmentsService } from '../commission/adjustments.service';
import { CommissionService } from '../commission/commission.service';
import { GrossProfitService } from './gross-profit.service';
import {
  AssignCrewDto,
  AssignTruckDto,
  CreateShipmentDto,
  SetGasRateOverrideDto,
  ShipmentListQueryDto,
  TransitionShipmentDto,
  UpdateRateChainDto,
  UpdateShipmentDto,
} from './shipments.dto';
import { ShipmentsService } from './shipments.service';

/**
 * Where a crew list falls back to when it asks for an ordering it may not
 * have. The same column `shipmentListQuerySchema` defaults to, named here so
 * the two cannot drift.
 */
const DEFAULT_SHIPMENT_SORT: ShipmentSortField = 'date';

@Controller('shipments')
export class ShipmentsController {
  constructor(
    private readonly shipments: ShipmentsService,
    private readonly commissions: CommissionService,
    private readonly grossProfits: GrossProfitService,
    private readonly adjustments: AdjustmentsService,
  ) {}

  /**
   * A crew session is confined to its own trips here, server-side.
   *
   * The filter is overwritten rather than validated, so a crew member passing
   * someone else's `staffId` gets their own list rather than an error —
   * there is no query string that widens it. This is the hard requirement from
   * the brief, and it is enforced at the only place that can enforce it: where
   * the session is known.
   */
  @Get()
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  async list(
    @Query() query: ShipmentListQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Page<Shipment>> {
    const page = await this.shipments.list(this.scopeToCaller(query, user));

    // The list carries the rate chain too, so redacting only the detail would
    // leave the same figures one screen earlier.
    return { ...page, items: page.items.map((row) => this.redactRevenueForCrew(row, user)) };
  }

  @Get(':id')
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  async get(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<Shipment> {
    const shipment = await this.shipments.get(id);

    this.assertCrewMayRead(shipment, user);

    return this.redactRevenueForCrew(shipment, user);
  }

  @Post()
  @Roles(...CAN_WRITE_SHIPMENTS)
  create(@Body() dto: CreateShipmentDto): Promise<Shipment> {
    return this.shipments.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_SHIPMENTS)
  update(@Param('id') id: string, @Body() dto: UpdateShipmentDto): Promise<Shipment> {
    return this.shipments.update(id, dto);
  }

  /**
   * Removing a trip: dispatch undoing a booking, or an administrator taking a
   * trip that ran out of the record.
   *
   * THE GUARD IS THE UNION OF THE TWO LISTS, necessarily — `RolesGuard` cannot
   * see the shipment's status, and the status is what decides which of the two
   * removals this is. The service applies the real policy, the same way the
   * transition endpoint applies `ROLES_BY_TRANSITION` for a decision the guard
   * cannot see either. `CAN_REMOVE_ANY_SHIPMENT` is a subset of the draft list
   * today, so the spread is about saying which lists govern this route rather
   * than about widening it.
   */
  @Delete(':id')
  @Roles(...CAN_REMOVE_DRAFT_SHIPMENTS, ...CAN_REMOVE_ANY_SHIPMENT)
  remove(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<{ removed: true }> {
    return this.shipments.remove(id, user);
  }

  /**
   * Correcting an agreed figure after the trip has left DRAFT.
   *
   * A NARROWER ROLE LIST THAN THE BOOKING EDIT ABOVE, which is the whole
   * reason it is a separate route: `PATCH :id` is every dispatcher's and shuts
   * at DRAFT, and this one outlives dispatch and belongs to the two roles that
   * answer for what was sold. Splitting them by route rather than by inspecting
   * the body keeps the guard able to see the decision — `RolesGuard` cannot
   * read a payload, so a single endpoint would have to admit the wider list and
   * re-check the narrower one by hand.
   */
  @Patch(':id/rate-chain')
  @Roles(...CAN_EDIT_RATE_CHAIN)
  updateRateChain(@Param('id') id: string, @Body() dto: UpdateRateChainDto): Promise<Shipment> {
    return this.shipments.updateRateChain(id, dto);
  }

  @Patch(':id/crew')
  @Roles(...CAN_WRITE_SHIPMENTS)
  assignCrew(@Param('id') id: string, @Body() dto: AssignCrewDto): Promise<Shipment> {
    return this.shipments.assignCrew(id, dto);
  }

  /**
   * Separate from `/crew` because it is a separate decision with a different
   * rule about when it may change — see `assignTruckSchema`. Dispatch's job
   * either way, so the same role list.
   */
  @Patch(':id/truck')
  @Roles(...CAN_WRITE_SHIPMENTS)
  assignTruck(@Param('id') id: string, @Body() dto: AssignTruckDto): Promise<Shipment> {
    return this.shipments.assignTruck(id, dto);
  }

  /**
   * The route-level guard is the union of everyone who may move a shipment at
   * all; which transition each role may actually drive is decided here, from
   * the policy map. The guard cannot do it, because it cannot see the body.
   */
  @Patch(':id/status')
  @Roles(...CAN_TRANSITION_SHIPMENTS)
  transition(
    @Param('id') id: string,
    @Body() dto: TransitionShipmentDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Shipment> {
    const allowed = ROLES_BY_TRANSITION[dto.to] ?? [];

    if (!allowed.includes(user.role)) {
      throw new ForbiddenException(
        `Your role may not move a shipment to ${SHIPMENT_STATUS_LABELS[dto.to].toLowerCase()}.`,
      );
    }

    return this.shipments.transition(id, dto);
  }

  /**
   * What the trip made, with the breakdown behind it.
   *
   * `CAN_READ_SHIPMENTS` without CREW, unlike the endpoints either side of it.
   * A crew member sees their own pay and their own liquidation because both are
   * their record; the company's margin on the trip they drove is not, and a
   * portal session that could read it could assemble the whole P&L one trip at
   * a time.
   */
  @Get(':id/gross-profit')
  @Roles(...CAN_READ_SHIPMENTS)
  grossProfit(@Param('id') id: string): Promise<GrossProfit> {
    return this.grossProfits.forShipment(id);
  }

  @Get(':id/gas-rate')
  @Roles(...CAN_READ_SHIPMENTS)
  gasRate(@Param('id') id: string) {
    return this.shipments.gasRateContext(id);
  }

  @Patch(':id/gas-rate')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  setGasRate(@Param('id') id: string, @Body() dto: SetGasRateOverrideDto): Promise<Shipment> {
    return this.shipments.setGasRateOverride(id, dto);
  }

  /**
   * OFFICE ONLY. `CAN_READ_SHIPMENTS` does not include CREW, and that omission
   * is the control — the portal no longer shows a crew member their commission
   * at all, and a card that is merely hidden is one `curl` away from being
   * visible.
   *
   * IF CREW IS EVER ADDED BACK HERE, this must filter to `user.staffId` before
   * returning: the list is every crew member on the trip, so an unfiltered
   * response hands somebody their colleague's pay. That filter used to live
   * here and was removed with the role, rather than left as unreachable code
   * that nothing exercises.
   */
  @Get(':id/commissions')
  @Roles(...CAN_READ_SHIPMENTS)
  listCommissions(@Param('id') id: string): Promise<Commission[]> {
    return this.commissions.listForShipment(id);
  }

  @Post(':id/commissions')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  compute(@Param('id') id: string): Promise<CommissionComputation> {
    return this.commissions.computeForShipment(id);
  }

  /**
   * What each crew member is actually owed for this trip: the computed
   * commission, the adjustments against it, and the total.
   *
   * A roll-up rather than a stored figure — the commission stays frozen and
   * self-verifying, the adjustments stay separately explainable, and only this
   * adds them up.
   *
   * OFFICE ONLY, like the commissions list it embeds. It was crew-visible, on
   * the reasoning that somebody should see a deduction here rather than
   * discover it from a short payout; that was overruled by explicit decision
   * and the cost is recorded in HANDOFF.md rather than left to be rediscovered.
   *
   * IF CREW IS EVER ADDED BACK HERE, filter to `user.staffId` — the roll-up
   * covers every crew member on the trip.
   */
  @Get(':id/crew-pay')
  @Roles(...CAN_READ_SHIPMENTS)
  crewPay(@Param('id') id: string): Promise<CrewPayLine[]> {
    return this.adjustments.crewPayForShipment(id);
  }

  // -------------------------------------------------------------------------

  private scopeToCaller(query: ShipmentListQueryDto, user: RequestUser): ShipmentListQueryDto {
    if (user.role !== UserRole.CREW) {
      return query;
    }

    if (!user.staffId) {
      // A crew login with no crew member is a broken account, not an
      // unfiltered one. Refusing beats returning the whole table.
      throw new ForbiddenException('This crew account is not linked to a crew member.');
    }

    // SORTING BY NET RATE IS PART OF THE REDACTION, not a separate concern.
    // The figures come back null for crew, but an ordering computed from them
    // hands back their ranking — enough to read off which of their own trips
    // earned the company most, which is exactly what nulling the column
    // refuses to say. Rewritten to the default rather than refused, for the
    // same reason `staffId` is: there is no query string that widens this.
    const sort = query.sort === 'netRate' ? DEFAULT_SHIPMENT_SORT : query.sort;

    return { ...query, staffId: user.staffId, sort };
  }

  /**
   * What a CREW session is allowed to know about a trip's money: the
   * commission base, and nothing it was derived from.
   *
   * WHY THE INTERMEDIATES GO TOO, and not just gross and TPC. The chain is
   * `net + commissionable charges = gross for commission`, then
   * `gross for commission − gas deduction = base`. Leaving the deduction or the
   * gross-for-commission on the response would let anyone reading it solve
   * backwards for the net rate — so redacting only the top three would be a
   * screen that looks private over a payload that is not. The base is the one
   * figure that concerns their pay and reveals nothing about what the client
   * was charged.
   *
   * Done HERE rather than in the card, because hiding a row in the browser is a
   * courtesy and this is a control: the JSON is one devtools tab away, and the
   * same rule already governs the commissions and crew-pay lists on this
   * controller.
   *
   * `totalAdvanced` GOES TOO, and it is not a revenue figure — it is the trip's
   * whole float, every custodian's releases summed. A helper reading it learns
   * what the driver was carrying, which is the one thing the per-custodian
   * accounts exist to keep separate. Their own is on the allowance summary,
   * scoped to the account they answer for.
   */
  private redactRevenueForCrew(shipment: Shipment, user: RequestUser): Shipment {
    if (user.role !== UserRole.CREW) {
      return shipment;
    }

    return {
      ...shipment,
      grossRate: null,
      tpcAmount: null,
      netRate: null,
      appliedTpcRate: null,
      commissionableCharges: null,
      grossForCommission: null,
      gasDeductionAmount: null,
      appliedGasDeductionRate: null,
      gasRateOverride: null,
      gasRateOverrideReason: null,
      commissionableBase: null,
      totalAdvanced: '0.00',
      // What the client was billed and what they still owe. Neither is on the
      // detail response at all, but the LIST carries both, so leaving them out
      // of this would be the same screen-private-payload-public mistake the
      // rate chain made.
      amountDue: null,
      balance: null,
    };
  }

  private assertCrewMayRead(shipment: Shipment, user: RequestUser): void {
    if (user.role !== UserRole.CREW) {
      return;
    }

    const worked =
      user.staffId !== null &&
      (shipment.driverId === user.staffId || shipment.helperId === user.staffId);

    if (!worked) {
      // Deliberately the same shape as a missing record: confirming that a
      // shipment exists is itself information a crew member has no claim to.
      throw new ForbiddenException('You can only view shipments you worked on.');
    }
  }
}
