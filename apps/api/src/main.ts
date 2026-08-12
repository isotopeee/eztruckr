import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import type { Env } from './config/env-schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService<Env, true>);
  const logger = new Logger('Bootstrap');

  app.setGlobalPrefix('api');

  // Global validation. Every Zod-typed DTO is parsed and stripped to its
  // schema, so unknown or system-owned fields never reach a service.
  app.useGlobalPipes(new ZodValidationPipe());

  app.enableCors({
    origin: config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    credentials: true,
  });

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${port}/api`);
  logger.log(`Health check at http://localhost:${port}/api/health`);
}

void bootstrap();
