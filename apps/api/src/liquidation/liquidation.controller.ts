import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { Liquidation, LiquidationLine } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_DECIDE_LIQUIDATION,
  CAN_READ_SHIPMENTS,
  CAN_SUBMIT_LIQUIDATION,
} from '../auth/role-policy';
import {
  ApproveLiquidationDto,
  CreateLiquidationLineDto,
  ReturnLiquidationDto,
  ReverseLiquidationDto,
  SubmitLiquidationDto,
  UpdateLiquidationLineDto,
} from './liquidation.dto';
import { LiquidationService } from './liquidation.service';
import { ShipmentAccessService } from './shipment-access.service';

/**
 * The liquidation of one trip, addressed through the trip.
 *
 * FOUR NAMED ACTIONS rather than one `PATCH /status`. The shipment lifecycle
 * has a generic transition endpoint because every move there carries the same
 * payload; here they do not — returning and reversing require a reason and
 * submitting and approving do not — and a single endpoint would have to accept
 * an optional reason and then decide, from the current status, whether it was
 * mandatory after all. The transition table in `@eztruckr/types` is still the
 * only thing that says which moves exist; each of these asks it.
 */
@Controller('shipments/:shipmentId/liquidation')
export class LiquidationController {
  constructor(
    private readonly liquidations: LiquidationService,
    private readonly access: ShipmentAccessService,
  ) {}

  @Get()
  @Roles(...CAN_SUBMIT_LIQUIDATION, ...CAN_READ_SHIPMENTS)
  async get(
    @Param('shipmentId') shipmentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    await this.access.assertMayRead(shipmentId, user);

    return this.liquidations.getForShipment(shipmentId);
  }

  @Post('lines')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  addLine(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateLiquidationLineDto,
    @CurrentUser() user: RequestUser,
  ): Promise<LiquidationLine> {
    return this.liquidations.addLine(shipmentId, dto, user);
  }

  @Patch('lines/:lineId')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  updateLine(
    @Param('shipmentId') shipmentId: string,
    @Param('lineId') lineId: string,
    @Body() dto: UpdateLiquidationLineDto,
    @CurrentUser() user: RequestUser,
  ): Promise<LiquidationLine> {
    return this.liquidations.updateLine(shipmentId, lineId, dto, user);
  }

  @Delete('lines/:lineId')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  removeLine(
    @Param('shipmentId') shipmentId: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ removed: true }> {
    return this.liquidations.removeLine(shipmentId, lineId, user);
  }

  @Post('submit')
  @Roles(...CAN_SUBMIT_LIQUIDATION)
  submit(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: SubmitLiquidationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    return this.liquidations.submit(shipmentId, dto, user);
  }

  @Post('return')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  returnToCrew(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: ReturnLiquidationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    return this.liquidations.returnToCrew(shipmentId, dto, user);
  }

  @Post('approve')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  approve(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: ApproveLiquidationDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Liquidation> {
    return this.liquidations.approve(shipmentId, dto, user);
  }

  /**
   * The origin is captured for the audit entry, as it is for a settings change.
   * Reversing an approval is the one move here that unwinds money already
   * decided, so the trail records where the request came from as well as who
   * made it.
   */
  @Post('reverse')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  reverse(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: ReverseLiquidationDto,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<Liquidation> {
    return this.liquidations.reverse(shipmentId, dto, user, {
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent') ?? null,
    });
  }
}
