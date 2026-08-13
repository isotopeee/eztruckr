import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page, Payee, RemovalResult } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_LIQUIDATION_REFERENCE_DATA, CAN_WRITE_PAYEES } from '../auth/role-policy';
import { CreatePayeeDto, ListQueryDto, UpdatePayeeDto } from './master-data.dto';
import { PayeesService } from './payees.service';

@Controller('payees')
export class PayeesController {
  constructor(private readonly payees: PayeesService) {}

  @Get()
  @Roles(...CAN_READ_LIQUIDATION_REFERENCE_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<Payee>> {
    return this.payees.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_LIQUIDATION_REFERENCE_DATA)
  get(@Param('id') id: string): Promise<Payee> {
    return this.payees.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_PAYEES)
  create(@Body() dto: CreatePayeeDto): Promise<Payee> {
    return this.payees.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_PAYEES)
  update(@Param('id') id: string, @Body() dto: UpdatePayeeDto): Promise<Payee> {
    return this.payees.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_PAYEES)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.payees.remove(id);
  }
}
