import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { AuthenticatedGuard } from './auth/authenticated.guard';
import { RolesGuard } from './auth/roles.guard';
import { SessionContextMiddleware } from './common/session-context.middleware';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { MasterDataModule } from './master-data/master-data.module';
import { PrismaModule } from './prisma/prisma.module';
import { SettingsModule } from './settings/settings.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    AppConfigModule,
    PrismaModule,
    AuthModule,
    StorageModule,
    HealthModule,
    UsersModule,
    MasterDataModule,
    SettingsModule,
  ],
  providers: [
    // Order matters: authentication decides who you are, then roles decide
    // what you may do. Both are global so protection is the default state of
    // a new controller rather than something added to it.
    { provide: APP_GUARD, useClass: AuthenticatedGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Every route resolves its session and opens an actor scope, so audit
    // stamping is automatic and the guards have a user to inspect.
    // `{*path}` is the path-to-regexp v8 wildcard used by Express 5 / Nest 11;
    // the older bare `*` is deprecated.
    consumer.apply(SessionContextMiddleware).forRoutes('{*path}');
  }
}
