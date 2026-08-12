import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { UserRole } from '@eztruckr/types';
import type { Request } from 'express';
import type { RequestUser } from './request-user';

export const IS_PUBLIC_KEY = 'eztruckr:public';
export const ROLES_KEY = 'eztruckr:roles';

/**
 * Marks a route as reachable without a session. Use sparingly — health checks
 * and the auth endpoints themselves.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * The roles allowed to call this route.
 *
 * Every non-public route must carry one: `RolesGuard` denies anything it finds
 * no declaration on, so forgetting the decorator produces a locked door rather
 * than an open one.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);

/**
 * Injects the authenticated user. Guaranteed present on any route the guards
 * admitted, which is why the handler signature can take it as non-optional.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestUser => {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.authUser) {
      // Unreachable through the guards; a loud failure beats a silent
      // undefined reaching a service that is about to scope a query by it.
      throw new Error('@CurrentUser() used on a route that does not require authentication');
    }

    return request.authUser;
  },
);
