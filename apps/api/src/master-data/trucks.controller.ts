import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page, RemovalResult, Truck } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_MASTER_DATA, CAN_WRITE_OPERATIONAL_MASTER_DATA } from '../auth/role-policy';
import { CreateTruckDto, ListQueryDto, UpdateTruckDto } from './master-data.dto';
import { TrucksService } from './trucks.service';

@Controller('trucks')
export class TrucksController {
  constructor(private readonly trucks: TrucksService) {}

  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<Truck>> {
    return this.trucks.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_MASTER_DATA)
  get(@Param('id') id: string): Promise<Truck> {
    return this.trucks.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  create(@Body() dto: CreateTruckDto): Promise<Truck> {
    return this.trucks.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateTruckDto): Promise<Truck> {
    return this.trucks.update(id, dto);
  }

  /**
   * Returns what actually happened rather than a bare 204 — a referenced truck
   * is deactivated, not deleted, and the caller needs to be told so.
   */
  @Delete(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.trucks.remove(id);
  }
}
