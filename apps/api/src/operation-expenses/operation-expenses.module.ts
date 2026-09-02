import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { OperationExpensesController } from './operation-expenses.controller';
import { OperationExpensesService } from './operation-expenses.service';

/**
 * Its own module, beside `ShipmentsModule` rather than inside it.
 *
 * The shipments module is "shipments and the money engine", and every provider
 * in it takes a shipment id. Overhead takes none — it depends on Prisma and on
 * the shared payee rule, and on nothing about a trip. Putting it there would
 * make the module's stated boundary untrue, and would import the whole
 * commission engine to record an electricity bill.
 */
@Module({
  imports: [PrismaModule],
  controllers: [OperationExpensesController],
  providers: [OperationExpensesService],
})
export class OperationExpensesModule {}
