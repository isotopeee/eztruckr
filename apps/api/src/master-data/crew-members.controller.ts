import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { UserRole, type CrewMember, type Page, type RemovalResult } from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { CAN_READ_MASTER_DATA, CAN_WRITE_OPERATIONAL_MASTER_DATA } from '../auth/role-policy';
import type { RequestUser } from '../auth/request-user';
import { CrewMembersService } from './crew-members.service';
import { CreateCrewMemberDto, ListQueryDto, UpdateCrewMemberDto } from './master-data.dto';

@Controller('crew-members')
export class CrewMembersController {
  constructor(private readonly crew: CrewMembersService) {}

  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  list(@Query() query: ListQueryDto): Promise<Page<CrewMember>> {
    return this.crew.list(query);
  }

  /**
   * Crew are allowed here, and only here, and only for themselves.
   *
   * Their portal has to be able to show them their own record. Scoping is a
   * server-side check against the session's `crewMemberId` — never a filter
   * the client asks for — so a crew login cannot read a colleague's address,
   * phone number or licence by changing the id in the URL.
   */
  @Get(':id')
  @Roles(...CAN_READ_MASTER_DATA, UserRole.CREW)
  get(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<CrewMember> {
    if (user.role === UserRole.CREW && user.crewMemberId !== id) {
      throw new ForbiddenException('You may only view your own crew record');
    }

    return this.crew.get(id);
  }

  @Post()
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  create(@Body() dto: CreateCrewMemberDto): Promise<CrewMember> {
    return this.crew.create(dto);
  }

  @Patch(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  update(@Param('id') id: string, @Body() dto: UpdateCrewMemberDto): Promise<CrewMember> {
    return this.crew.update(id, dto);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE_OPERATIONAL_MASTER_DATA)
  remove(@Param('id') id: string): Promise<RemovalResult> {
    return this.crew.remove(id);
  }
}
