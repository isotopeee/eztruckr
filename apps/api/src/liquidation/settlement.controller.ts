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

  @Get('shipments/:shipmentId/settlement')
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_SUBMIT_LIQUIDATION)
  async get(
    @Param('shipmentId') shipmentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<Settlement> {
    await this.access.assertMayRead(shipmentId, user);

    return this.settlements.getForShipment(shipmentId);
  }

  @Post('shipments/:shipmentId/settlement/record')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  record(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: RecordSettlementDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Settlement> {
    return this.settlements.record(shipmentId, dto, user);
  }

  @Post('shipments/:shipmentId/settlement/carry-to-payout')
  @Roles(...CAN_DECIDE_LIQUIDATION)
  carryToPayout(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CarrySettlementToPayoutDto,
  ): Promise<Settlement> {
    return this.settlements.carryToPayout(shipmentId, dto);
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
