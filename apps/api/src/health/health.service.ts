import { Injectable } from '@nestjs/common';
import type { HealthResponse } from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async check(): Promise<HealthResponse> {
    const [databaseUp, storageStatus] = await Promise.all([
      this.prisma.ping(),
      this.storage.check(),
    ]);

    // Storage being unconfigured ("skipped") is not a degradation.
    const degraded = !databaseUp || storageStatus === 'down';

    return {
      status: degraded ? 'degraded' : 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: {
        database: databaseUp ? 'up' : 'down',
        storage: storageStatus,
      },
    };
  }
}
