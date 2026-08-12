import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { AdditionalCharge, BillableExpense } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_SHIPMENTS, CAN_WRITE_SHIPMENT_MONEY } from '../auth/role-policy';
import {
  CreateAdditionalChargeDto,
  CreateBillableExpenseDto,
  UpdateAdditionalChargeDto,
  UpdateBillableExpenseDto,
} from './shipments.dto';
import { ShipmentChargesService } from './shipment-charges.service';

/**
 * Charge lines hang off a shipment, so they are addressed through it. Nesting
 * the path is not decoration: every handler checks the line belongs to the
 * shipment named in the URL, which is what stops one trip's status governing
 * another trip's money.
 */
@Controller('shipments/:shipmentId')
export class ShipmentChargesController {
  constructor(private readonly charges: ShipmentChargesService) {}

  @Get('billable-expenses')
  @Roles(...CAN_READ_SHIPMENTS)
  listBillableExpenses(@Param('shipmentId') shipmentId: string): Promise<BillableExpense[]> {
    return this.charges.listBillableExpenses(shipmentId);
  }

  @Post('billable-expenses')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  addBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateBillableExpenseDto,
  ): Promise<BillableExpense> {
    return this.charges.addBillableExpense(shipmentId, dto);
  }

  @Patch('billable-expenses/:id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  updateBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateBillableExpenseDto,
  ): Promise<BillableExpense> {
    return this.charges.updateBillableExpense(shipmentId, id, dto);
  }

  @Delete('billable-expenses/:id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  removeBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
  ): Promise<{ removed: true }> {
    return this.charges.removeBillableExpense(shipmentId, id);
  }

  @Get('additional-charges')
  @Roles(...CAN_READ_SHIPMENTS)
  listAdditionalCharges(@Param('shipmentId') shipmentId: string): Promise<AdditionalCharge[]> {
    return this.charges.listAdditionalCharges(shipmentId);
  }

  @Post('additional-charges')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  addAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateAdditionalChargeDto,
  ): Promise<AdditionalCharge> {
    return this.charges.addAdditionalCharge(shipmentId, dto);
  }

  @Patch('additional-charges/:id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  updateAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAdditionalChargeDto,
  ): Promise<AdditionalCharge> {
    return this.charges.updateAdditionalCharge(shipmentId, id, dto);
  }

  @Delete('additional-charges/:id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  removeAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
  ): Promise<{ removed: true }> {
    return this.charges.removeAdditionalCharge(shipmentId, id);
  }
}
