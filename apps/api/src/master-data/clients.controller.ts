import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Client, Page, RemovalResult } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_MASTER_DATA, CAN_WRITE_OPERATIONAL_MASTER_DATA } from '../auth/role-policy';
import { ClientsService } from './clients.service';
import { CreateClientDto, ListQueryDto, UpdateClientDto } from './master-data.dto';

@Controller('clients')
export class ClientsController {
  constructor(private readonly clients: ClientsService) {}

  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<Client>> {
    return this.clients.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_MASTER_DATA)
  get(@Param('id') id: string): Promise<Client> {
    return this.clients.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  create(@Body() dto: CreateClientDto): Promise<Client> {
    return this.clients.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateClientDto): Promise<Client> {
    return this.clients.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.clients.remove(id);
  }
}
