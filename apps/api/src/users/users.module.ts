import { Module } from '@nestjs/common';
import { InvitationsController } from './invitations.controller';
import { InvitationsService } from './invitations.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/**
 * Login provisioning, invitations and `/api/me`. AuthService, MailService and
 * PrismaService all come from global modules.
 *
 * `InvitationsService` is exported because the sign-in hook in `auth.ts` asks
 * it whether an account still owes an acceptance.
 */
@Module({
  controllers: [UsersController, InvitationsController],
  providers: [UsersService, InvitationsService],
  exports: [UsersService, InvitationsService],
})
export class UsersModule {}
