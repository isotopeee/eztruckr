import { Controller, Get, Query } from '@nestjs/common';
import type { ProfitAndLoss } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_PROFIT_AND_LOSS } from '../auth/role-policy';
import { ProfitAndLossQueryDto } from './profit-and-loss.dto';
import { ProfitAndLossService } from './profit-and-loss.service';

/**
 * The company's profit and loss, addressed on its own.
 *
 * A TOP-LEVEL RESOURCE with no id in the path, like `/operation-expenses` and
 * for the mirror of its reason: that one is not nested under a shipment because
 * it has no shipment, and this one is not because it has all of them.
 *
 * READ-ONLY, AND THERE IS NOTHING TO WRITE. Every figure is derived from rows
 * that already have their own endpoints, so a POST here would be a second way
 * to record something — the `grossProfit` column this system deliberately does
 * not have, wearing a URL. Corrections are made where the money was recorded,
 * and the report follows.
 *
 * ONE ENDPOINT, not a summary beside a list. `/operation-expenses` needs both
 * because the ledger's rows are records somebody types; here the rows ARE the
 * breakdown and travel with the total, so splitting them would only create the
 * chance for a heading and a table to describe different periods.
 *
 * WHO MAY READ IT is `CAN_READ_PROFIT_AND_LOSS`, which is the overhead ledger's
 * list rather than the shipments' — the report contains that ledger, so it
 * cannot be more widely readable than it. The argument is on the bundle.
 */
@Controller('profit-and-loss')
export class ProfitAndLossController {
  constructor(private readonly profitAndLoss: ProfitAndLossService) {}

  @Get()
  @Roles(...CAN_READ_PROFIT_AND_LOSS)
  report(@Query() query: ProfitAndLossQueryDto): Promise<ProfitAndLoss> {
    return this.profitAndLoss.report(query);
  }
}
