import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { validateEnv } from './env-schema';

/**
 * Global configuration. Every other module injects `ConfigService` rather than
 * reading `process.env` directly, so the validated schema is the only source
 * of environment truth.
 */
@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // Root .env of the monorepo, then any app-local override.
      envFilePath: ['.env.local', '.env', '../../.env'],
      validate: validateEnv,
    }),
  ],
  exports: [ConfigModule],
})
export class AppConfigModule {}

export { ConfigService };
