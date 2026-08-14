import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { acceptInvitationSchema, type InvitationPreview } from '@eztruckr/types';
import { Public } from '../auth/auth.decorators';
import { createZodDto } from '../common/create-zod-dto';
import { InvitationsService } from './invitations.service';

class AcceptInvitationDto extends createZodDto(acceptInvitationSchema) {}

/**
 * The two endpoints an invitee can reach WITHOUT a session, because not having
 * one is the entire point: they cannot sign in until this has been done.
 *
 * `@Public()` is used sparingly and every use is a decision. What guards these
 * instead of a session is the token — 32 random bytes, single-use, expiring,
 * and stored only as a hash — which is the same shape of secret a password
 * reset link carries.
 *
 * NOT MOUNTED UNDER `/users`, which is admin-only in every other respect.
 * Hanging an unauthenticated route off that prefix would make the users
 * controller a mix of "administrators only" and "anyone with a link", and the
 * next person adding a route there would have to notice which kind theirs is.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  /**
   * Validate a link before showing a password form.
   *
   * Lets the page distinguish expired from revoked from never-existed, and lets
   * the invitee see whose account they are about to take over before they
   * commit a password to it.
   */
  @Get(':token')
  @Public()
  preview(@Param('token') token: string): Promise<InvitationPreview> {
    return this.invitations.preview(token);
  }

  @Post('accept')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  accept(@Body() dto: AcceptInvitationDto): Promise<void> {
    return this.invitations.accept(dto.token, dto.password);
  }
}
