import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { AdditionalCharge, BillableExpense, ShipmentChargeQueueItem } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import type { RequestUser } from '../auth/request-user';
import {
  CAN_ADD_SHIPMENT_CHARGE,
  CAN_APPROVE_SHIPMENT_CHARGE,
  CAN_READ_SHIPMENTS,
} from '../auth/role-policy';
import {
  CreateAdditionalChargeDto,
  CreateBillableExpenseDto,
  ReturnShipmentChargeDto,
  ShipmentChargeQueueQueryDto,
  UpdateAdditionalChargeDto,
  UpdateBillableExpenseDto,
} from './shipments.dto';
import { ShipmentChargesService } from './shipment-charges.service';

/**
 * Charge lines hang off a shipment, so they are addressed through it. Nesting
 * the path is not decoration: every handler checks the line belongs to the
 * shipment named in the URL, which is what stops one trip's status governing
 * another trip's money.
 *
 * WRITES ARE `CAN_ADD_SHIPMENT_CHARGE`, which admits the dispatcher. What keeps
 * that safe is in the service: their lines count for nothing until accounting
 * approves them, and an approved line is closed to them.
 */
@Controller()
export class ShipmentChargesController {
  constructor(private readonly charges: ShipmentChargesService) {}

  // --- the queue, across trips ---------------------------------------------

  /** Accounting's work and the dispatcher's wait — one list read from two sides. */
  @Get('shipment-charges')
  @Roles(...CAN_READ_SHIPMENTS)
  queue(@Query() query: ShipmentChargeQueueQueryDto): Promise<ShipmentChargeQueueItem[]> {
    return this.charges.queue(query);
  }

  // --- billable expenses ---------------------------------------------------

  @Get('shipments/:shipmentId/billable-expenses')
  @Roles(...CAN_READ_SHIPMENTS)
  listBillableExpenses(@Param('shipmentId') shipmentId: string): Promise<BillableExpense[]> {
    return this.charges.listBillableExpenses(shipmentId);
  }

  @Post('shipments/:shipmentId/billable-expenses')
  @Roles(...CAN_ADD_SHIPMENT_CHARGE)
  addBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateBillableExpenseDto,
    @CurrentUser() user: RequestUser,
  ): Promise<BillableExpense> {
    return this.charges.addBillableExpense(shipmentId, dto, user);
  }

  @Patch('shipments/:shipmentId/billable-expenses/:id')
  @Roles(...CAN_ADD_SHIPMENT_CHARGE)
  updateBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateBillableExpenseDto,
    @CurrentUser() user: RequestUser,
  ): Promise<BillableExpense> {
    return this.charges.updateBillableExpense(shipmentId, id, dto, user);
  }

  @Delete('shipments/:shipmentId/billable-expenses/:id')
  @Roles(...CAN_ADD_SHIPMENT_CHARGE)
  removeBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ removed: true }> {
    return this.charges.removeBillableExpense(shipmentId, id, user);
  }

  @Post('shipments/:shipmentId/billable-expenses/:id/approve')
  @Roles(...CAN_APPROVE_SHIPMENT_CHARGE)
  approveBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<BillableExpense | AdditionalCharge> {
    return this.charges.approve(shipmentId, 'billable-expense', id, user);
  }

  @Post('shipments/:shipmentId/billable-expenses/:id/return')
  @Roles(...CAN_APPROVE_SHIPMENT_CHARGE)
  returnBillableExpense(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: ReturnShipmentChargeDto,
    @CurrentUser() user: RequestUser,
  ): Promise<BillableExpense | AdditionalCharge> {
    return this.charges.returnForCorrection(shipmentId, 'billable-expense', id, dto, user);
  }

  // --- additional charges --------------------------------------------------

  @Get('shipments/:shipmentId/additional-charges')
  @Roles(...CAN_READ_SHIPMENTS)
  listAdditionalCharges(@Param('shipmentId') shipmentId: string): Promise<AdditionalCharge[]> {
    return this.charges.listAdditionalCharges(shipmentId);
  }

  @Post('shipments/:shipmentId/additional-charges')
  @Roles(...CAN_ADD_SHIPMENT_CHARGE)
  addAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateAdditionalChargeDto,
    @CurrentUser() user: RequestUser,
  ): Promise<AdditionalCharge> {
    return this.charges.addAdditionalCharge(shipmentId, dto, user);
  }

  @Patch('shipments/:shipmentId/additional-charges/:id')
  @Roles(...CAN_ADD_SHIPMENT_CHARGE)
  updateAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateAdditionalChargeDto,
    @CurrentUser() user: RequestUser,
  ): Promise<AdditionalCharge> {
    return this.charges.updateAdditionalCharge(shipmentId, id, dto, user);
  }

  @Delete('shipments/:shipmentId/additional-charges/:id')
  @Roles(...CAN_ADD_SHIPMENT_CHARGE)
  removeAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<{ removed: true }> {
    return this.charges.removeAdditionalCharge(shipmentId, id, user);
  }

  @Post('shipments/:shipmentId/additional-charges/:id/approve')
  @Roles(...CAN_APPROVE_SHIPMENT_CHARGE)
  approveAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
  ): Promise<BillableExpense | AdditionalCharge> {
    return this.charges.approve(shipmentId, 'additional-charge', id, user);
  }

  @Post('shipments/:shipmentId/additional-charges/:id/return')
  @Roles(...CAN_APPROVE_SHIPMENT_CHARGE)
  returnAdditionalCharge(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: ReturnShipmentChargeDto,
    @CurrentUser() user: RequestUser,
  ): Promise<BillableExpense | AdditionalCharge> {
    return this.charges.returnForCorrection(shipmentId, 'additional-charge', id, dto, user);
  }
}
