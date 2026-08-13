import type { UserRole } from '@eztruckr/types';

/**
 * The authenticated user, resolved once per request by
 * `SessionContextMiddleware` and read by the guards and controllers.
 *
 * Deliberately narrow: it carries what authorisation decisions need and
 * nothing else, so no handler is tempted to trust a stale copy of a record it
 * should be reading from the database.
 */
export interface RequestUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  isActive: boolean;
  /** Non-null only for CREW logins. The scope key for every crew-facing read. */
  staffId: string | null;
}

declare module 'express' {
  interface Request {
    /** Set by SessionContextMiddleware; undefined when unauthenticated. */
    authUser?: RequestUser;
  }
}
