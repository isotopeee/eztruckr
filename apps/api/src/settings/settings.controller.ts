import { Body, Controller, Get, Patch, Req } from '@nestjs/common';
import { updateSystemSettingSchema, type SettingChange, type SystemSetting } from '@eztruckr/types';
import type { Request } from 'express';
import { CurrentUser, Roles } from '../auth/auth.decorators';
import { CAN_ADMINISTER } from '../auth/role-policy';
import type { RequestUser } from '../auth/request-user';
import { createZodDto } from '../common/create-zod-dto';
import { SettingsService, type RequestOrigin } from './settings.service';

class UpdateSystemSettingDto extends createZodDto(updateSystemSettingSchema) {}

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /**
   * Administrator only, read included.
   *
   * These rates are company financial policy, not reference data, so the whole
   * row stays closed rather than being readable by anyone with a desk. When a
   * later screen needs to show the gas deduction rate beside a commission it
   * computed, that should arrive through an endpoint returning just that value
   * — a narrow read for a specific purpose, rather than this one widened until
   * it is no longer administrator-only in any meaningful sense.
   */
  @Get()
  @Roles(...CAN_ADMINISTER)
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
