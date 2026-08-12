import { UserRole } from '@eztruckr/types';
import type { ExtendedPrismaClient } from '@eztruckr/db';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError, createAuthMiddleware } from 'better-auth/api';

/**
 * Better Auth, configured against the tables Phase 2 already modelled.
 *
 * The `user` table IS Better Auth's user table: it carries exactly the columns
 * Better Auth defines (name, email, emailVerified, image, createdAt,
 * updatedAt) and nothing is renamed or removed. Presentation and contact
 * detail live in `UserProfile`, which extends the login rather than modifying
 * it, so Better Auth's own schema stays intact.
 *
 * The three EZTruckr columns that do sit on `user` — role, isActive,
 * crewMemberId — are declared below as `additionalFields`, which is Better
 * Auth's supported extension mechanism. They are deliberately kept off
 * UserProfile: a profile row is soft-deletable and partial-unique, so a user
 * can legitimately have zero live profiles, and a user with no resolvable role
 * is a security hole rather than a cosmetic gap.
 *
 * Every one of them is `input: false`, so no request body can ever set them —
 * not at sign-up, not at update. Roles are assigned only by the admin-guarded
 * users service, through Prisma.
 */

/** Sessions last a week, sliding: any request inside a day extends them. */
const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 7;
const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;

/**
 * Long enough to matter, short enough that an operations clerk will accept it.
 * Better Auth's own default is 8, which is too weak for a system that moves
 * money.
 */
const MIN_PASSWORD_LENGTH = 12;

export interface AuthOptions {
  secret: string;
  baseURL: string;
  /** Origins allowed to drive the auth endpoints, i.e. the web app. */
  trustedOrigins: string[];
}

export function createAuth(prisma: ExtendedPrismaClient, options: AuthOptions) {
  return betterAuth({
    appName: 'EZTruckr',
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: '/api/auth',
    trustedOrigins: options.trustedOrigins,

    database: prismaAdapter(prisma, { provider: 'postgresql' }),

    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Accounts are provisioned by an administrator, so nobody is ever
      // "signing themselves up" and expecting to land logged in.
      autoSignIn: false,
    },

    user: {
      additionalFields: {
        /** Code set: UserRole. Never settable from a request body. */
        role: {
          type: 'number',
          required: false,
          defaultValue: UserRole.CREW,
          input: false,
        },
        isActive: {
          type: 'boolean',
          required: false,
          defaultValue: true,
          input: false,
        },
        /** Set only for CREW logins; scopes every crew-facing query. */
        crewMemberId: {
          type: 'string',
          required: false,
          input: false,
        },
      },
    },

    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },

    databaseHooks: {
      session: {
        create: {
          /**
           * Stamp `lastLoginAt`. A new session row is the only honest
           * definition of "signed in".
           *
           * Written with raw SQL deliberately, to bypass the audit extension.
           * Going through `prisma.user.update` would stamp `updatedBy` — and
           * the actor at this moment is null, because the session being
           * created is the very thing that would identify them. That would
           * quietly erase a real `updatedBy` from whoever last edited the
           * account, every time its owner logged in. Signing in is not an
           * edit to the record, and the audit columns should not claim it is.
           */
          after: async (session) => {
            await prisma.$executeRaw`
              UPDATE "user" SET "lastLoginAt" = NOW() WHERE "id" = ${session.userId}
            `;
          },
        },
      },
    },

    hooks: {
      /**
       * There is no public registration. Mounting the Better Auth handler
       * exposes `/api/auth/sign-up/email` whether we want it or not, so it is
       * closed here rather than left to routing.
       *
       * `ctx.request` is present only when the call arrived over HTTP. The
       * admin users service calls `auth.api.signUpEmail({ body })` in-process,
       * where it is undefined — so provisioning still works and the public
       * route does not. `auth.test.ts` asserts both halves, because this is
       * the single thing standing between a stranger and an account.
       */
      before: createAuthMiddleware((ctx) => {
        if (ctx.path === '/sign-up/email' && ctx.request) {
          throw new APIError('FORBIDDEN', {
            message: 'Accounts are created by an administrator, not by signing up.',
          });
        }
        return Promise.resolve();
      }),
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
