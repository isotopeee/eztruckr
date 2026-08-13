import {
  Body,
  Controller,
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
} from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_READ_SHIPMENTS,
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
  UpdateShipmentDto,
} from './shipments.dto';
import { ShipmentsService } from './shipments.service';

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
  list(
    @Query() query: ShipmentListQueryDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Page<Shipment>> {
    return this.shipments.list(this.scopeToCaller(query, user));
  }

  @Get(':id')
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  async get(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<Shipment> {
    const shipment = await this.shipments.get(id);

    this.assertCrewMayRead(shipment, user);

    return shipment;
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

  @Get(':id/commissions')
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  async listCommissions(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Commission[]> {
    const shipment = await this.shipments.get(id);

    this.assertCrewMayRead(shipment, user);

    const commissions = await this.commissions.listForShipment(id);

    // A crew member sees their own pay on a shared trip, never their
    // colleague's.
    return user.role === UserRole.CREW
      ? commissions.filter((row) => row.staffId === user.staffId)
      : commissions;
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
   * adds them up. Crew-visible, filtered to the caller's own line for the same
   * reason the commissions list is: a crew member should see a deduction here
   * rather than discover it from a short payout.
   */
  @Get(':id/crew-pay')
  @Roles(...CAN_READ_SHIPMENTS, UserRole.CREW)
  async crewPay(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<CrewPayLine[]> {
    const shipment = await this.shipments.get(id);

    this.assertCrewMayRead(shipment, user);

    const lines = await this.adjustments.crewPayForShipment(id);

    return user.role === UserRole.CREW
      ? lines.filter((line) => line.staffId === user.staffId)
      : lines;
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

    return { ...query, staffId: user.staffId };
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
