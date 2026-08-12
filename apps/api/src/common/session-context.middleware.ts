import { Injectable, type NestMiddleware } from '@nestjs/common';
import { withActor } from '@eztruckr/db';
import type { NextFunction, Request, Response } from 'express';
import { AuthService } from '../auth/auth.service';

/**
 * Resolves the session once per request, hangs the user on the request for the
 * guards, and opens the actor scope every Prisma write beneath it is stamped
 * with.
 *
 * One lookup serves both jobs. Doing it in middleware rather than in a guard
 * matters: middleware runs before guards, so `req.authUser` is already
 * populated when `AuthenticatedGuard` and `RolesGuard` ask for it, and the
 * audit extension sees a real actor even on the request that fails
 * authorisation.
 *
 * `next()` is called INSIDE `withActor`, so everything downstream — including
 * async continuations, which AsyncLocalStorage propagates — runs in the scope.
 */
@Injectable()
export class SessionContextMiddleware implements NestMiddleware {
  constructor(private readonly auth: AuthService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const user = await this.auth.resolveUser(req.headers);

    if (user) {
      req.authUser = user;
    }

    withActor({ userId: user?.id ?? null }, () => {
      next();
    });
  }
}
