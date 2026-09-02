import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { OperationExpense, OperationExpenseSummary, Page } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_OPERATION_EXPENSES, CAN_WRITE_OPERATION_EXPENSES } from '../auth/role-policy';
import {
  CreateOperationExpenseDto,
  OperationExpenseListQueryDto,
  OperationExpenseSummaryQueryDto,
  UpdateOperationExpenseDto,
} from './operation-expenses.dto';
import { OperationExpensesService } from './operation-expenses.service';

/**
 * The company's own running costs, addressed on their own.
 *
 * A TOP-LEVEL RESOURCE, not `/shipments/:id/…`, which is the whole point of the
 * record: there is no trip in the path because there is no trip. Every other
 * cost endpoint in this system is nested under the shipment that caused it, and
 * nesting this one anywhere would be asking which trip pays the office lease.
 *
 * ACCOUNTING'S AND THE ADMINISTRATOR'S. Neither dispatch role appears, on
 * either side — not as a control this time but as a job description: nothing a
 * dispatcher does touches the payroll bill. MANAGEMENT reads and writes
 * nothing, which is the shape every read bundle in `role-policy.ts` takes.
 *
 * CREW ARE ABSENT for the reason `CompanyPaidExpensesController` spells out, and
 * more strongly: a portal session that could read this ledger could assemble
 * the company's entire cost base from a phone.
 */
@Controller('operation-expenses')
export class OperationExpensesController {
  constructor(private readonly expenses: OperationExpensesService) {}

  @Get()
  @Roles(...CAN_READ_OPERATION_EXPENSES)
  list(@Query() query: OperationExpenseListQueryDto): Promise<Page<OperationExpense>> {
    return this.expenses.list(query);
  }

  /**
   * Declared BEFORE `:id`, and it has to be. Nest matches routes in
   * declaration order, so a `@Get(':id')` above this one would swallow
   * `/operation-expenses/summary` and answer it with a 400 from `idSchema` —
   * a confusing failure for a path that is not an id at all.
   */
  @Get('summary')
  @Roles(...CAN_READ_OPERATION_EXPENSES)
  summarise(@Query() query: OperationExpenseSummaryQueryDto): Promise<OperationExpenseSummary> {
    return this.expenses.summarise(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_OPERATION_EXPENSES)
  get(@Param('id') id: string): Promise<OperationExpense> {
    return this.expenses.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_OPERATION_EXPENSES)
  add(@Body() dto: CreateOperationExpenseDto): Promise<OperationExpense> {
    return this.expenses.add(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_OPERATION_EXPENSES)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateOperationExpenseDto,
  ): Promise<OperationExpense> {
    return this.expenses.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_OPERATION_EXPENSES)
  remove(@Param('id') id: string): Promise<{ removed: true }> {
    return this.expenses.remove(id);
  }
}
