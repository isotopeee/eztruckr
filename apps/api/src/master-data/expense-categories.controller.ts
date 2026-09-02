import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { ExpenseCategory, Page, RemovalResult } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import {
  CAN_READ_LIQUIDATION_REFERENCE_DATA,
  CAN_WRITE_FINANCIAL_MASTER_DATA,
} from '../auth/role-policy';
import { ExpenseCategoriesService } from './expense-categories.service';
import {
  CreateExpenseCategoryDto,
  ExpenseCategoryListQueryDto,
  UpdateExpenseCategoryDto,
} from './master-data.dto';

@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(private readonly categories: ExpenseCategoriesService) {}

  /**
   * Readable by everyone with a desk — the liquidation form needs the list —
   * but written only by accounting, since these decide how spend is
   * classified and whether it is commissionable.
   */
  @Get()
  @Roles(...CAN_READ_LIQUIDATION_REFERENCE_DATA)
  list(@Query() query: ExpenseCategoryListQueryDto): Promise<Page<ExpenseCategory>> {
    return this.categories.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_LIQUIDATION_REFERENCE_DATA)
  get(@Param('id') id: string): Promise<ExpenseCategory> {
    return this.categories.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_FINANCIAL_MASTER_DATA)
  create(@Body() dto: CreateExpenseCategoryDto): Promise<ExpenseCategory> {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_FINANCIAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateExpenseCategoryDto): Promise<ExpenseCategory> {
    return this.categories.update(id, dto);
  }

  /**
   * The one endpoint in the system that can really delete something: an
   * expense category nothing has been filed under. Anything already used
   * deactivates instead, and the response says which happened.
   */
  @Delete(':id')
  @Roles(...CAN_WRITE_FINANCIAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.categories.remove(id);
  }
}
