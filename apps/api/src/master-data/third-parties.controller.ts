import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Page, RemovalResult, ThirdParty } from '@eztruckr/types';
import { Roles } from '../auth/auth.decorators';
import { CAN_READ_MASTER_DATA, CAN_WRITE_OPERATIONAL_MASTER_DATA } from '../auth/role-policy';
import { CreateThirdPartyDto, ListQueryDto, UpdateThirdPartyDto } from './master-data.dto';
import { ThirdPartiesService } from './third-parties.service';

@Controller('third-parties')
export class ThirdPartiesController {
  constructor(private readonly thirdParties: ThirdPartiesService) {}

  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<ThirdParty>> {
    return this.thirdParties.list(query);
  }

  @Get(':id')
  @Roles(...CAN_READ_MASTER_DATA)
  get(@Param('id') id: string): Promise<ThirdParty> {
    return this.thirdParties.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  create(@Body() dto: CreateThirdPartyDto): Promise<ThirdParty> {
    return this.thirdParties.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateThirdPartyDto): Promise<ThirdParty> {
    return this.thirdParties.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.thirdParties.remove(id);
  }
}
