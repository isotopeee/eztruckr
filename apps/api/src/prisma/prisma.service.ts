import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { createPrismaClient, type ExtendedPrismaClient } from '@eztruckr/db';

/**
 * Owns the audit-extended Prisma client's lifecycle.
 *
 * Services inject this and use `prisma.client`. There is no unextended client
 * anywhere in the API, so createdBy / updatedBy stamping cannot be bypassed.
 */
@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  readonly client: ExtendedPrismaClient = createPrismaClient();

  async onModuleInit(): Promise<void> {
    await this.client.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.$disconnect();
  }

  /** Cheap liveness probe used by the health endpoint. */
  async ping(): Promise<boolean> {
    try {
      await this.client.$queryRaw`SELECT 1`;
      return true;
    } catch (error) {
      this.logger.error('Database ping failed', error instanceof Error ? error.stack : error);
      return false;
    }
  }
}
