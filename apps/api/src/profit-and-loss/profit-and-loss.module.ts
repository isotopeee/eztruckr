import { Module } from '@nestjs/common';
import { OperationExpensesModule } from '../operation-expenses/operation-expenses.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ProfitAndLossController } from './profit-and-loss.controller';
import { ProfitAndLossService } from './profit-and-loss.service';

/**
 * Its own module, beside the two it reads from rather than inside either.
 *
 * NOT IN `ShipmentsModule`, whose every provider takes a shipment id — this one
 * takes a date window and returns a figure no trip has. Not in
 * `OperationExpensesModule` either, which exists precisely to be the thing that
 * belongs to no trip, and would become the home of a report that is mostly
 * about trips.
 *
 * IT IMPORTS THE OVERHEAD MODULE RATHER THAN THE SHIPMENTS ONE, which is the
 * asymmetry worth explaining. The overhead line is taken from
 * `OperationExpensesService.summarise` — the same total, category breakdown
 * included, that `/operation-expenses` renders — so the module is imported and
 * the service injected. The trip figures need no service at all: `grossProfitOf`
 * is a pure function, so the arithmetic is shared without dragging in the
 * commission engine, the charges controllers and the payout machinery that
 * `ShipmentsModule` would bring with it.
 */
@Module({
  imports: [PrismaModule, OperationExpensesModule],
  controllers: [ProfitAndLossController],
  providers: [ProfitAndLossService],
})
export class ProfitAndLossModule {}
