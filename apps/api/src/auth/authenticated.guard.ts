import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IS_PUBLIC_KEY } from './auth.decorators';

/**
 * Requires a session on every route that is not explicitly `@Public()`.
 *
 * Registered globally in `AppModule`, so a new controller is protected the
 * moment it exists rather than when someone remembers to decorate it.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.authUser;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    // Deactivated is distinct from deleted: a deleted user cannot resolve a
    // session at all (the soft-delete extension hides them), while a
    // deactivated one still exists and deserves an answer that says so.
    if (!user.isActive) {
      throw new ForbiddenException('This account has been deactivated');
    }

    return true;
  }
}
