import { Module } from '@nestjs/common';
import { AdjustmentsController } from '../commission/adjustments.controller';
import { AdjustmentsService } from '../commission/adjustments.service';
import { CommissionCoverageService } from '../commission/commission-coverage.service';
import { CommissionController } from '../commission/commission.controller';
import { CommissionService } from '../commission/commission.service';
import { PrismaModule } from '../prisma/prisma.module';
import { CompanyPaidExpensesController } from './company-paid-expenses.controller';
import { CompanyPaidExpensesService } from './company-paid-expenses.service';
import { GrossProfitService } from './gross-profit.service';
import { ShipmentChargesController } from './shipment-charges.controller';
import { ShipmentChargesService } from './shipment-charges.service';
import { ShipmentsController } from './shipments.controller';
import { ShipmentsService } from './shipments.service';

/**
 * Shipments and the money engine ship together, because the engine has no
 * meaning without a shipment to compute and the shipment controller is what
 * exposes computation. The services stay separate classes: `ShipmentsService`
 * owns what a shipment is and when it may change, `CommissionService` owns
 * what the crew are paid, and only the latter does arithmetic.
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    ShipmentsController,
    ShipmentChargesController,
    CompanyPaidExpensesController,
    CommissionController,
    AdjustmentsController,
  ],
  providers: [
    ShipmentsService,
    ShipmentChargesService,
    CompanyPaidExpensesService,
    GrossProfitService,
    CommissionService,
    CommissionCoverageService,
    AdjustmentsService,
  ],
  exports: [CommissionService, CommissionCoverageService, AdjustmentsService],
})
export class ShipmentsModule {}
