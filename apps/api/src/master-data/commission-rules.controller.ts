import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { CommissionRule, Page, RemovalResult } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_MASTER_DATA, CAN_WRITE_FINANCIAL_MASTER_DATA } from '../auth/role-policy';
import { CommissionRulesService } from './commission-rules.service';
import { CreateCommissionRuleDto, ListQueryDto, UpdateCommissionRuleDto } from './master-data.dto';

@Controller('commission-rules')
export class CommissionRulesController {
  constructor(private readonly rules: CommissionRulesService) {}

  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<CommissionRule>> {
    return this.rules.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_MASTER_DATA)
  get(@Param('id') id: string): Promise<CommissionRule> {
    return this.rules.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_FINANCIAL_MASTER_DATA)
  create(@Body() dto: CreateCommissionRuleDto): Promise<CommissionRule> {
    return this.rules.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_FINANCIAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateCommissionRuleDto): Promise<CommissionRule> {
    return this.rules.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_FINANCIAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.rules.remove(id);
  }
}
