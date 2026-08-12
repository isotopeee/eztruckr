import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { toNodeHandler } from 'better-auth/node';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';
import { AuthService } from './auth/auth.service';
import { PrismaExceptionFilter } from './common/prisma-exception.filter';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import type { Env } from './config/env-schema';

async function bootstrap(): Promise<void> {
  // `bodyParser: false` is required, not a preference. Better Auth's handler
  // reads the raw request stream itself, so a JSON parser running ahead of it
  // consumes the body and every sign-in hangs or arrives empty. We mount the
  // auth handler first and turn parsing back on immediately after, so only the
  // auth routes see an unparsed body.
  const app = await NestFactory.create(AppModule, { bufferLogs: true, bodyParser: false });
  const config = app.get(ConfigService<Env, true>);
  const logger = new Logger('Bootstrap');

  // CORS FIRST. `enableCors` registers Express middleware in call order, and
  // the auth handler below terminates the request itself — so enabling CORS
  // after it would leave exactly the sign-in route without the headers, which
  // fails only in the browser and only cross-origin.
  app.enableCors({
    origin: config
      .get('CORS_ORIGINS', { infer: true })
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    // Session cookies do not cross origins without this.
    credentials: true,
  });

  const auth = app.get(AuthService);
  app.use('/api/auth', toNodeHandler(auth.instance));

  app.use(json({ limit: '1mb' }));
  app.use(urlencoded({ extended: true, limit: '1mb' }));

  app.setGlobalPrefix('api');

  // Global validation. Every Zod-typed DTO is parsed and stripped to its
  // schema, so unknown or system-owned fields never reach a service.
  app.useGlobalPipes(new ZodValidationPipe());

  // Turns the database's own guarantees — partial uniques, ON DELETE RESTRICT,
  // the payout triggers — into honest 409s and 404s instead of blanket 500s.
  app.useGlobalFilters(new PrismaExceptionFilter());

  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  logger.log(`API listening on http://localhost:${port}/api`);
  logger.log(`Health check at http://localhost:${port}/api/health`);
  logger.log(`Auth endpoints at http://localhost:${port}/api/auth`);
}

void bootstrap();
