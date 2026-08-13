import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@eztruckr/types';
import { describe, expect, it } from 'vitest';
import { IS_PUBLIC_KEY, ROLES_KEY } from './auth.decorators';
import { AuthenticatedGuard } from './authenticated.guard';
import type { RequestUser } from './request-user';
import { RolesGuard } from './roles.guard';

/**
 * A stand-in for Nest's metadata lookup. `getAllAndOverride` reads the handler
 * first and falls back to the class, which is what lets a controller-level
 * @Roles be narrowed on one method.
 */
function reflectorReturning(metadata: Record<string, unknown>): Reflector {
  return {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;
}

function contextWith(user?: RequestUser): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ authUser: user }) }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const admin: RequestUser = {
  id: 'u1',
  email: 'admin@eztruckr.ph',
  name: 'Admin',
  role: UserRole.ADMINISTRATOR,
  isActive: true,
  staffId: null,
};

const crew: RequestUser = {
  id: 'u2',
  email: 'driver@eztruckr.ph',
  name: 'Driver',
  role: UserRole.CREW,
  isActive: true,
  staffId: 'crew-1',
};

describe('AuthenticatedGuard', () => {
  it('lets a public route through with no session', () => {
    const guard = new AuthenticatedGuard(reflectorReturning({ [IS_PUBLIC_KEY]: true }));
    expect(guard.canActivate(contextWith())).toBe(true);
  });

  it('rejects an unauthenticated request to a protected route', () => {
    const guard = new AuthenticatedGuard(reflectorReturning({}));
    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });

  it('admits an authenticated, active user', () => {
    const guard = new AuthenticatedGuard(reflectorReturning({}));
    expect(guard.canActivate(contextWith(admin))).toBe(true);
  });

  it('refuses a deactivated account, and says so rather than claiming no session', () => {
    // Deactivated is not deleted: the account exists, and a user staring at a
    // login screen that keeps accepting their password deserves the reason.
    const guard = new AuthenticatedGuard(reflectorReturning({}));
    expect(() => guard.canActivate(contextWith({ ...admin, isActive: false }))).toThrow(
      ForbiddenException,
    );
  });
});

describe('RolesGuard', () => {
  it('lets a public route through', () => {
    const guard = new RolesGuard(reflectorReturning({ [IS_PUBLIC_KEY]: true }));
    expect(guard.canActivate(contextWith())).toBe(true);
  });

  it('FAILS CLOSED on a route that declares no roles', () => {
    // The whole point: a controller added without @Roles is shut, not open.
    const guard = new RolesGuard(reflectorReturning({}));
    expect(() => guard.canActivate(contextWith(admin))).toThrow(ForbiddenException);
  });

  it('fails closed on an empty role list too', () => {
    const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: [] }));
    expect(() => guard.canActivate(contextWith(admin))).toThrow(ForbiddenException);
  });

  it('admits a permitted role', () => {
    const guard = new RolesGuard(
      reflectorReturning({ [ROLES_KEY]: [UserRole.ADMINISTRATOR, UserRole.OPERATIONS] }),
    );
    expect(guard.canActivate(contextWith(admin))).toBe(true);
  });

  it('refuses a role that is not listed, naming it', () => {
    const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: [UserRole.ADMINISTRATOR] }));
    expect(() => guard.canActivate(contextWith(crew))).toThrow(/Crew member is not permitted/);
  });

  it('treats roles as membership, not rank', () => {
    // ADMINISTRATOR is code 1 and CREW is code 5; a guard that compared codes
    // rather than testing membership would let the wrong one through here.
    const crewOnly = new RolesGuard(reflectorReturning({ [ROLES_KEY]: [UserRole.CREW] }));
    expect(crewOnly.canActivate(contextWith(crew))).toBe(true);
    expect(() => crewOnly.canActivate(contextWith(admin))).toThrow(ForbiddenException);
  });

  it('rejects an unauthenticated request even where roles are declared', () => {
    const guard = new RolesGuard(reflectorReturning({ [ROLES_KEY]: [UserRole.ADMINISTRATOR] }));
    expect(() => guard.canActivate(contextWith())).toThrow(UnauthorizedException);
  });
});
