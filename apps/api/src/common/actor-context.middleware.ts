import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { withActor } from '@eztruckr/db';

/**
 * Opens an actor scope for the whole request so every Prisma write beneath it
 * is stamped with the acting user, without any service having to thread a
 * userId through its call signatures.
 *
 * Phase 1 has no authentication yet, so the actor is always null and audit
 * columns record `null` for system writes. Phase 2 replaces the lookup below
 * with the Better Auth session user; nothing else has to change.
 */
@Injectable()
export class ActorContextMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction): void {
    const userId = this.resolveUserId(req);
    withActor({ userId }, () => next());
  }

  private resolveUserId(_req: Request): string | null {
    // TODO(phase-2): return the Better Auth session user's id.
    return null;
  }
}
