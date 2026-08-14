import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { UserRole, type Liquidation, type LiquidationLine } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_DECIDE_LIQUIDATION,
  CAN_READ_SHIPMENTS,
  CAN_SUBMIT_LIQUIDATION,
  CAN_WRITE_SHIPMENT_MONEY,
} from '../auth/role-policy';
import {
  ApproveLiquidationDto,
  CreateLiquidationDto,
  CreateLiquidationLineDto,
  ReturnLiquidationDto,
  ReverseLiquidationDto,
  SetCustodianDto,
  SubmitLiquidationDto,
  UpdateLiquidationLineDto,
} from './liquidation.dto';
import { LiquidationService } from './liquidation.service';
import { ShipmentAccessService } from './shipment-access.service';

/**
 * One custodian's account of a trip's cash.
 *
 * ADDRESSED BY ITS OWN ID, not through the shipment. It hung off
 * `/shipments/:id/liquidation` while a trip could only have one, and that path
 * stopped identifying anything the moment a second cash holder could exist —
 * every action below is about one person's account, and only the list and the
 * create are about the trip.
 *
 * FOUR NAMED ACTIONS rather than one `PATCH /status`. The shipment lifecycle
 * has a generic transition endpoint because every move there carries the same
 * payload; here they do not — returning and reversing require a reason and
 * submitting and approving do not — and a single endpoint would have to accept
 * an optional reason and then decide, from the current status, whether it was
 * mandatory after all. The transition table in `@eztruckr/types` is still the
 * only thing that says which moves exist; each of these asks it.
 */
@Controller()
export class LiquidationController {
  constructor(
    private readonly liquidations: LiquidationService,
    private readonly access: ShipmentAccessService,
  ) {}

  // --- through the trip ------------------------------------------------

  /**
   * Every account on the trip — except to a crew member, who sees only their
   * own.
   *
   * A LIQUIDATION IS ONE PERSON'S ACCOUNT OF CASH THEY HELD, and a crew member
   * has no more claim to a colleague's than to their commission: it names what
   * they were advanced, what they spent it on, and whether they came up short.
   * The same filter the commissions and crew-pay lists already apply, for the
   * same reason.
   *
   * Filtered on CUSTODIAN, not on who received the cash. A helper handed ferry
   * money out of the driver's float appears on an `Allowance` inside the
   * driver's account, and that account is still the driver's to answer for —
   * scoping by recipient would hand the helper a liquidation they cannot
   * submit and cannot be short on.
   */
  @Get('shipments/:shipmentId/liquidations')
  @Roles(...CAN_SUBMIT_LIQUIDATION, ...CAN_READ_SHIPMENTS)
  async listForShipment(
    @Param('shipmentId') shipmentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation[]> {
    await this.access.assertMayRead(shipmentId, user);

    const accounts = await this.liquidations.listForShipment(shipmentId);

    if (user.role !== UserRole.CREW) {
      return accounts;
    }

    // The account created at BOOKING has no custodian yet. It is deliberately
    // NOT shown to crew: it is nobody's account until the office names one, and
    // offering it would let a crew member claim expenses against a float they
    // were never given.
    return accounts.filter((account) => account.custodianId === user.staffId);
  }

  /**
   * Opening a second account, for a second cash holder.
   *
   * `CAN_WRITE_SHIPMENT_MONEY` rather than the wider submit list: deciding that
   * a helper carries their own cash is the same kind of call as releasing it,
   * and crews should not be able to open accounts for themselves.
   */
  @Post('shipments/:shipmentId/liquidations')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  create(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateLiquidationDto,
  ): Promise<Liquidation> {
    return this.liquidations.createForShipment(shipmentId, dto);
  }

  // --- the account itself ----------------------------------------------

  @Get('liquidations/:liquidationId')
  @Roles(...CAN_SUBMIT_LIQUIDATION, ...CAN_READ_SHIPMENTS)
  async get(
    @Param('liquidationId') liquidationId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    const liquidation = await this.liquidations.get(liquidationId);

    await this.access.assertMayRead(liquidation.shipmentId, user);

    return liquidation;
  }

  @Patch('liquidations/:liquidationId/custodian')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  setCustodian(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: SetCustodianDto,
  ): Promise<Liquidation> {
    return this.liquidations.setCustodian(liquidationId, dto);
  }

  @Delete('liquidations/:liquidationId')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  remove(@Param('liquidationId') liquidationId: string): Promise<{ removed: true }> {
    return this.liquidations.remove(liquidationId);
  }

  // --- lines -------------------------------------------------------------

  @Post('liquidations/:liquidationId/lines')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  addLine(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: CreateLiquidationLineDto,
    @CurrentUser() user: RequestUser,
  ): Promise<LiquidationLine> {
    return this.liquidations.addLine(liquidationId, dto, user);
  }

  @Patch('liquidations/:liquidationId/lines/:lineId')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  updateLine(
    @Param('liquidationId') liquidationId: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateLiquidationLineDto,
    @CurrentUser() user: RequestUser,
  ): Promise<LiquidationLine> {
    return this.liquidations.updateLine(liquidationId, lineId, dto, user);
  }

  @Delete('liquidations/:liquidationId/lines/:lineId')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  removeLine(
    @Param('liquidationId') liquidationId: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ removed: true }> {
    return this.liquidations.removeLine(liquidationId, lineId, user);
  }

  // --- the four moves ----------------------------------------------------

  @Post('liquidations/:liquidationId/submit')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  submit(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: SubmitLiquidationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    return this.liquidations.submit(liquidationId, dto, user);
  }

  @Post('liquidations/:liquidationId/return')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  returnToCrew(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: ReturnLiquidationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    return this.liquidations.returnToCrew(liquidationId, dto, user);
  }

  @Post('liquidations/:liquidationId/approve')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  approve(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: ApproveLiquidationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    return this.liquidations.approve(liquidationId, dto, user);
  }

  /**
   * The origin is captured for the audit entry, as it is for a settings change.
   * Reversing an approval is the one move here that unwinds money already
   * decided, so the trail records where the request came from as well as who
   * made it.
   */
  @Post('liquidations/:liquidationId/reverse')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  reverse(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: ReverseLiquidationDto,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<Liquidation> {
    return this.liquidations.reverse(liquidationId, dto, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
  }
}
