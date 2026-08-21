import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AllowanceRequestsController } from './allowance-requests.controller';
import { AllowanceRequestsService } from './allowance-requests.service';
import { AllowancesController } from './allowances.controller';
import { AllowancesService } from './allowances.service';
import { LiquidationController } from './liquidation.controller';
import { LiquidationService } from './liquidation.service';
import { LiquidationsController } from './liquidations.controller';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { ShipmentAccessService } from './shipment-access.service';

/**
 * Allowance, liquidation, receipts and settlement — the cash trail of a trip,
 * from the money going out to whatever comes back.
 *
 * They ship together because they are one story told in four records, and each
 * one is meaningless without the next: an allowance with no liquidation is cash
 * that vanished, a liquidation with no settlement is spending accounted for
 * with the change unaccounted for.
 *
 * NOTE WHAT IS NOT HERE. `ShipmentsModule` creates the PENDING liquidation when
 * a trip is delivered, through the plain function in `pending-liquidation.ts`
 * rather than through this module's service. That is deliberate: injecting
 * `LiquidationService` into `ShipmentsService`, which every service here
 * depends on in turn, would be a dependency cycle for the sake of one create.
 */
@Module({
  imports: [PrismaModule],
  controllers: [
    AllowancesController,
    AllowanceRequestsController,
    LiquidationController,
    LiquidationsController,
    SettlementController,
    ReceiptsController,
  ],
  providers: [
    ShipmentAccessService,
    ReceiptsService,
    LiquidationService,
    AllowancesService,
    AllowanceRequestsService,
    SettlementService,
  ],
  exports: [LiquidationService, SettlementService],
})
export class LiquidationModule {}
