import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUserRole } from '@eztruckr/types';
import { fromNodeHeaders } from 'better-auth/node';
import type { IncomingHttpHeaders } from 'node:http';
import type { Env } from '../config/env-schema';
import { PrismaService } from '../prisma/prisma.service';
import { createAuth, type Auth } from './auth';
import type { RequestUser } from './request-user';

/**
 * Owns the Better Auth instance and is the only place a session is turned into
 * a `RequestUser`.
 *
 * The instance is built over the same audit- and soft-delete-extended Prisma
 * client every other service uses, which is what makes a soft-deleted user
 * un-authenticatable for free: the extension adds `deletedAt: null` to the
 * lookup Better Auth performs, so their session resolves to nothing.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  readonly instance: Auth;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.instance = createAuth(this.prisma.client, {
      secret: config.get('BETTER_AUTH_SECRET', { infer: true }),
      baseURL: config.get('BETTER_AUTH_URL', { infer: true }),
      trustedOrigins: config
        .get('CORS_ORIGINS', { infer: true })
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    });
  }

  /**
   * Resolve the caller from their session cookie, or null.
   *
   * Returns null rather than throwing on a bad session: "not signed in" is an
   * ordinary state, and the guards decide what it costs.
   */
  async resolveUser(headers: IncomingHttpHeaders): Promise<RequestUser | null> {
    let session: Awaited<ReturnType<Auth['api']['getSession']>>;

    try {
      session = await this.instance.api.getSession({ headers: fromNodeHeaders(headers) });
    } catch (error) {
      this.logger.warn(
        `Session lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }

    if (!session?.user) {
      return null;
    }

    const { user } = session;

    // The role column is a SMALLINT the database checks, but it arrives here
    // through Better Auth's loosely-typed additional fields. Validate rather
    // than cast: an unrecognised code must not silently become an authorised
    // one, and a row that fails this is corrupt in a way worth logging.
    if (!isUserRole(user.role)) {
      this.logger.error(`User ${user.id} has an unrecognised role code: ${String(user.role)}`);
      return null;
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive !== false,
      crewMemberId: user.crewMemberId ?? null,
    };
  }
}
