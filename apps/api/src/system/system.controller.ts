import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { initializeSystemSchema, type SystemStatus } from '@eztruckr/types';
import { Public } from '../auth/auth.decorators';
import { createZodDto } from '../common/create-zod-dto';
import { SystemService } from './system.service';

class InitializeSystemDto extends createZodDto(initializeSystemSchema) {}

/**
 * First-run setup. Both routes are `@Public()` because there is nobody to
 * authenticate as until they have been used.
 *
 * `@Public()` is used sparingly and every use is a decision. What guards these
 * is not a session but `system_setting.initializedAt`: `status` is safe to
 * answer for anyone, and `initialize` answers exactly once in the life of an
 * installation. See `SystemService` for why that flag is stored rather than
 * derived from whether an administrator happens to exist.
 */
@Controller('system')
export class SystemController {
  constructor(private readonly system: SystemService) {}

  /**
   * Deliberately says nothing but yes or no. The web app polls it before
   * rendering, so it is reachable by anyone who can reach the API at all, and
   * a count of users or the administrator's address would be a free gift.
   */
  @Get('status')
  @Public()
  status(): Promise<SystemStatus> {
    return this.system.status();
  }

  /**
   * 204, not the created administrator. The caller is an anonymous browser on
   * a setup page; echoing back a user record would tell whoever ran it more
   * about the account than they need before they have proven they hold the
   * mailbox it was sent to.
   */
  @Post('initialize')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  initialize(@Body() dto: InitializeSystemDto): Promise<void> {
    return this.system.initialize(dto);
  }
}
