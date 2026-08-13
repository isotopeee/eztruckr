import { Module } from '@nestjs/common';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';
import { CommissionRulesController } from './commission-rules.controller';
import { CommissionRulesService } from './commission-rules.service';
import { StaffController } from './staff.controller';
import { StaffService } from './staff.service';
import { ExpenseCategoriesController } from './expense-categories.controller';
import { ExpenseCategoriesService } from './expense-categories.service';
import { RoutesController } from './routes.controller';
import { RoutesService } from './routes.service';
import { ThirdPartiesController } from './third-parties.controller';
import { ThirdPartiesService } from './third-parties.service';
import { TrucksController } from './trucks.controller';
import { TrucksService } from './trucks.service';

/**
 * The reference tables everything else points at: trucks, crew, clients,
 * brokers, routes, expense categories and commission rules.
 *
 * PrismaService comes from the global PrismaModule, so nothing is imported
 * here.
 */
@Module({
  controllers: [
    TrucksController,
    StaffController,
    ClientsController,
    ThirdPartiesController,
    RoutesController,
    ExpenseCategoriesController,
    CommissionRulesController,
  ],
  providers: [
    TrucksService,
    StaffService,
    ClientsService,
    ThirdPartiesService,
    RoutesService,
    ExpenseCategoriesService,
    CommissionRulesService,
  ],
  exports: [StaffService],
})
export class MasterDataModule {}
