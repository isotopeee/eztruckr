import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import type { OutstandingAllowanceReport, Settlement } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_DECIDE_LIQUIDATION,
  CAN_READ_SHIPMENTS,
  CAN_SUBMIT_LIQUIDATION,
} from '../auth/role-policy';
import { CarrySettlementToPayoutDto, RecordSettlementDto } from './liquidation.dto';
import { SettlementService } from './settlement.service';
import { ShipmentAccessService } from './shipment-access.service';

@Controller()
export class SettlementController {
  constructor(
    private readonly settlements: SettlementService,
    private readonly access: ShipmentAccessService,
  ) {}

  /**
   * Every account's settlement on one trip — except to a crew member, who sees
   * only their own.
   *
   * A list, because a trip can carry one per cash holder — the driver may have
   * squared up while the helper has not, and a single record could not say so.
   * Which is exactly why it is scoped: a settlement names one custodian, what
   * they came up short by, and whether it was recovered from their pay.
   */
  @Get('shipments/:shipmentId/settlements')
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_SUBMIT_LIQUIDATION)
  async listForShipment(
    @Param('shipmentId') shipmentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Settlement[]> {
    await this.access.assertMayRead(shipmentId, user);

    return this.settlements.listForShipment(shipmentId, this.access.accountScopeFor(user));
  }

  @Get('liquidations/:liquidationId/settlement')
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_SUBMIT_LIQUIDATION)
  async get(
    @Param('liquidationId') liquidationId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Settlement> {
    await this.access.assertMayReadAccount(liquidationId, user);

    return this.settlements.getForLiquidation(liquidationId);
  }

  @Post('liquidations/:liquidationId/settlement/record')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  record(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: RecordSettlementDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Settlement> {
    return this.settlements.record(liquidationId, dto, user);
  }

  @Post('liquidations/:liquidationId/settlement/carry-to-payout')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  carryToPayout(
    @Param('liquidationId') liquidationId: string,
    @Body() dto: CarrySettlementToPayoutDto,
  ): Promise<Settlement> {
    return this.settlements.carryToPayout(liquidationId, dto);
  }

  /**
   * The "allowances outstanding" alert, for the dashboard.
   *
   * Not nested under a shipment because it is a question about all of them, and
   * it reads settlement statuses directly — a dashboard that walked the
   * liquidations instead would be answering a different question and would say
   * a trip was clear while the crew still held the change.
   */
  @Get('settlements/outstanding')
  @Roles(...CAN_READ_SHIPMENTS)
  outstanding(): Promise<OutstandingAllowanceReport> {
    return this.settlements.outstanding();
  }
}
