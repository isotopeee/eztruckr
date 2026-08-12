import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { USER_ROLE_LABELS, type UserRole } from '@eztruckr/types';
import type { Request } from 'express';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';

/**
 * Enforces `@Roles(...)` on every non-public route.
 *
 * FAILS CLOSED. A route with no `@Roles` declaration is refused outright
 * rather than allowed through, so "role guards on every endpoint" is a
 * property of the system instead of a review checklist item — a controller
 * added without a role declaration returns 403 on its first call, which is
 * noticed immediately and costs nothing, where the opposite default is noticed
 * after it has leaked payroll to a dispatcher.
 *
 * Roles are never ranked. This is a membership test, exactly as the UserRole
 * code set requires: ACCOUNTING is not "more" than OPERATIONS.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const allowed = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!allowed || allowed.length === 0) {
      throw new ForbiddenException(
        'This endpoint declares no permitted roles and is therefore closed. ' +
          'Add @Roles(...) or @Public() to it.',
      );
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.authUser;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    if (!allowed.includes(user.role)) {
      throw new ForbiddenException(
        `${USER_ROLE_LABELS[user.role]} is not permitted to perform this action`,
      );
    }

    return true;
  }
}
