import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import type { CompanyPaidExpense } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_SHIPMENTS, CAN_WRITE_SHIPMENT_MONEY } from '../auth/role-policy';
import { CompanyPaidExpensesService } from './company-paid-expenses.service';
import { CreateCompanyPaidExpenseDto, UpdateCompanyPaidExpenseDto } from './shipments.dto';

/**
 * Costs the company paid directly, addressed through the trip they belong to.
 *
 * ACCOUNTING'S, NOT DISPATCH'S — `CAN_WRITE_SHIPMENT_MONEY`, the same list as
 * charges and the gas override. Operations owns where the truck goes; what a
 * trip cost the company is a P&L entry.
 *
 * CREW ARE NOT ON THE READ LIST EITHER, and that is the deliberate part. A crew
 * member sees what they were advanced and what they liquidated, because both
 * are their own record. Fleet-card fuel and workshop invoices are the company's
 * margin, and `CAN_READ_SHIPMENTS` excludes CREW precisely so that a portal
 * session cannot assemble one.
 */
@Controller('shipments/:shipmentId/company-expenses')
export class CompanyPaidExpensesController {
  constructor(private readonly expenses: CompanyPaidExpensesService) {}

  @Get()
  @Roles(...CAN_READ_SHIPMENTS)
  list(@Param('shipmentId') shipmentId: string): Promise<CompanyPaidExpense[]> {
    return this.expenses.list(shipmentId);
  }

  @Post()
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  add(
    @Param('shipmentId') shipmentId: string,
    @Body() dto: CreateCompanyPaidExpenseDto,
  ): Promise<CompanyPaidExpense> {
    return this.expenses.add(shipmentId, dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  update(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCompanyPaidExpenseDto,
  ): Promise<CompanyPaidExpense> {
    return this.expenses.update(shipmentId, id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_SHIPMENT_MONEY)
  remove(
    @Param('shipmentId') shipmentId: string,
    @Param('id') id: string,
  ): Promise<{ removed: true }> {
    return this.expenses.remove(shipmentId, id);
  }
}
