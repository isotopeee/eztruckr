import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page, RemovalResult, Route } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_MASTER_DATA, CAN_WRITE_OPERATIONAL_MASTER_DATA } from '../auth/role-policy';
import { CreateRouteDto, ListQueryDto, UpdateRouteDto } from './master-data.dto';
import { RoutesService } from './routes.service';

@Controller('routes')
export class RoutesController {
  constructor(private readonly routes: RoutesService) {}

  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<Route>> {
    return this.routes.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_MASTER_DATA)
  get(@Param('id') id: string): Promise<Route> {
    return this.routes.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  create(@Body() dto: CreateRouteDto): Promise<Route> {
    return this.routes.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateRouteDto): Promise<Route> {
    return this.routes.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.routes.remove(id);
  }
}
