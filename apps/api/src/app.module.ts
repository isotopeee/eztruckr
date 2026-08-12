import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ActorContextMiddleware } from './common/actor-context.middleware';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [AppConfigModule, PrismaModule, StorageModule, HealthModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route runs inside an actor scope so audit stamping is automatic.
    // `{*path}` is the path-to-regexp v8 wildcard used by Express 5 / Nest 11;
    // the older bare `*` is deprecated.
    consumer.apply(ActorContextMiddleware).forRoutes('{*path}');
  }
}
