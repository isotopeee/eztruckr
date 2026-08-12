import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { updateSystemSettingSchema, type SettingChange, type SystemSetting } from '@eztruckr/types';
import type { Request } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { CAN_ADMINISTER, CAN_READ_MASTER_DATA } from '../auth/role-policy';
import type { RequestUser } from '../auth/request-user';
import { createZodDto } from '../common/create-zod-dto';
import { SettingsService, type RequestOrigin } from './settings.service';

class UpdateSystemSettingDto extends createZodDto(updateSystemSettingSchema) {}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Readable by anyone with a desk — the gas deduction rate explains numbers
   * they see elsewhere — but writable only by an administrator.
   */
  @Get()
  @Roles(...CAN_READ_MASTER_DATA)
  get(): Promise<SystemSetting> {
    return this.settings.get();
  }

  @Patch()
  @Roles(...CAN_ADMINISTER)
  update(
    @Body() dto: UpdateSystemSettingDto,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<SystemSetting> {
    return this.settings.update(dto, user, requestOrigin(request));
  }

  /** Who changed what, when, and what it was before. */
  @Get('history')
  @Roles(...CAN_ADMINISTER)
  history(): Promise<SettingChange[]> {
    return this.settings.history();
  }
}

function requestOrigin(request: Request): RequestOrigin {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
  };
}
