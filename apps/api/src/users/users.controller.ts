import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createUserSchema,
  masterDataListQuerySchema,
  setPasswordSchema,
  updateUserSchema,
  type Page,
  type RemovalResult,
  type SessionUser,
  type StaffInvitation,
  type User,
} from '@eztruckr/types';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { ANY_SIGNED_IN_ROLE, CAN_ADMINISTER } from '../auth/role-policy';
import type { RequestUser } from '../auth/request-user';
import { createZodDto } from '../common/create-zod-dto';
import { InvitationsService } from './invitations.service';
import { UsersService } from './users.service';

class ListUsersDto extends createZodDto(masterDataListQuerySchema) {}
class CreateUserDto extends createZodDto(createUserSchema) {}
class UpdateUserDto extends createZodDto(updateUserSchema) {}
class SetPasswordDto extends createZodDto(setPasswordSchema) {}

@Controller()
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
  ) {}

  /**
   * Who am I. Every role may ask, including crew.
   *
   * The web app re-reads this rather than trusting anything it stored, so a
   * role change or a deactivation takes effect on the next request instead of
   * the next login.
   */
  @Get('me')
  @Roles(...ANY_SIGNED_IN_ROLE)
  me(@CurrentUser() user: RequestUser): Promise<SessionUser> {
    return this.users.currentUser(user);
  }

  @Get('users')
  @Roles(...CAN_ADMINISTER)
  list(@Query() query: ListUsersDto): Promise<Page<User>> {
    return this.users.list(query);
  }

  @Get('users/:id')
  @Roles(...CAN_ADMINISTER)
  get(@Param('id') id: string): Promise<User> {
    return this.users.get(id);
  }

  @Post('users')
  @Roles(...CAN_ADMINISTER)
  create(@Body() dto: CreateUserDto): Promise<User> {
    return this.users.create(dto);
  }

  @Patch('users/:id')
  @Roles(...CAN_ADMINISTER)
  update(@Param('id') id: string, @Body() dto: UpdateUserDto): Promise<User> {
    return this.users.update(id, dto);
  }

  /**
   * Set a password directly, for the account-recovery case the invite flow does
   * not cover: somebody locked out whose mailbox is also gone.
   *
   * Kept, but it is no longer how an account STARTS — `POST /users` mints an
   * invitation instead, so this is a break-glass tool rather than the normal
   * path. An administrator using it does know the password afterwards, which is
   * precisely why provisioning stopped working this way.
   */
  @Post('users/:id/password')
  @Roles(...CAN_ADMINISTER)
  @HttpCode(HttpStatus.NO_CONTENT)
  setPassword(@Param('id') id: string, @Body() dto: SetPasswordDto): Promise<void> {
    return this.users.setPassword(id, dto.password);
  }

  /**
   * Resend an invite. Mints a NEW token and revokes the outstanding one, so a
   * link that was forwarded to the wrong address stops working the moment a
   * replacement is sent — a resend that merely re-sent the same token would
   * leave both live.
   */
  @Post('users/:id/invitation')
  @Roles(...CAN_ADMINISTER)
  resendInvitation(@Param('id') id: string): Promise<StaffInvitation> {
    return this.invitations.issue(id);
  }

  @Delete('users/:id/invitation')
  @Roles(...CAN_ADMINISTER)
  revokeInvitation(@Param('id') id: string): Promise<StaffInvitation> {
    return this.invitations.revoke(id);
  }

  @Delete('users/:id')
  @Roles(...CAN_ADMINISTER)
  remove(@Param('id') id: string, @CurrentUser() actor: RequestUser): Promise<RemovalResult> {
    return this.users.remove(id, actor);
  }
}
