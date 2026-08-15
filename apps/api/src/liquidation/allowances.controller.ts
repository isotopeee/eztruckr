import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { Allowance, AllowanceSummary } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_READ_SHIPMENTS,
  CAN_SUBMIT_LIQUIDATION,
  CAN_WRITE_SHIPMENT_MONEY,
} from '../auth/role-policy';
import { AllowancesService } from './allowances.service';
import { IssueAllowanceDto, UpdateAllowanceDto } from './liquidation.dto';
import { ShipmentAccessService } from './shipment-access.service';

/**
 * Allowances hang off a shipment, so they are addressed through it.
 *
 * There is no `PATCH /shipments/:id/allowance` and there never will be: a
 * release is a POST that adds a row, because cash handed over twice happened
 * twice. The GET returns every release plus the total advanced, which is the
 * figure the variance is measured against.
 *
 * Issuing is `CAN_WRITE_SHIPMENT_MONEY` — cash leaving the company is
 * accounting's, on the same reasoning that puts charges and the gas override
 * there, even though operations owns the trip. Crew may read their own trip's
 * releases so the portal can show what they were given.
 */
@Controller('shipments/:shipmentId/allowances')
export class AllowancesController {
  constructor(
    private readonly allowances: AllowancesService,
    private readonly access: ShipmentAccessService,
  ) {}

  @Get()
  @Roles(...CAN_READ_SHIPMENTS, ...CAN_SUBMIT_LIQUIDATION)
  async summary(
    @Param('shipmentId') shipmentId: string,
    @CurrentUser() user: RequestUser,
  ): Promise<AllowanceSummary> {
    await this.access.assertMayRead(shipmentId, user);

    return this.allowances.summary(shipmentId, this.access.accountScopeFor(user));
  }

  @Post()
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  issue(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: IssueAllowanceDto,
    @CurrentUser() user: RequestUser,
  ): Promise<Allowance> {
    return this.allowances.issue(shipmentId, dto, user);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  update(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAllowanceDto,
  ): Promise<Allowance> {
    return this.allowances.update(shipmentId, id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  remove(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
  ): Promise<{ removed: true }> {
    return this.allowances.remove(shipmentId, id);
  }
}
