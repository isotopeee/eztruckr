import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import type { HealthResponse } from '@eztruckr/types';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /**
   * Always 200 so container orchestrators can distinguish "process is
   * serving" from "a dependency is unhappy"; read `status` for the latter.
   */
  @Get()
  @HttpCode(HttpStatus.OK)
  check(): Promise<HealthResponse> {
    return this.health.check();
  }
}
