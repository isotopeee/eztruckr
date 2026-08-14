import type { ExtendedPrismaClient } from '@eztruckr/db';

/**
 * Does this email address belong to a login that has not been taken up yet?
 *
 * Stated ONCE, here, because two callers need it and they sit on opposite sides
 * of the app: the Better Auth sign-in hook (which has a Prisma client and no
 * Nest DI) and `InvitationsService` (which has both). Splitting it would mean
 * two readings of the same rule and two chances to update only one — the same
 * reason `payee-requirement.ts` exists.
 *
 * THE THREE CASES, and why the last one is not an oversight:
 *
 * - An invitation was accepted at some point → the account is live. Later
 *   invitations, if any, do not un-accept it.
 * - Invitations exist and none was accepted → refuse. This deliberately covers
 *   the REVOKED and EXPIRED cases as well as the pending one: an administrator
 *   who withdraws an invite expects the account to stay shut, and an account
 *   whose only invite lapsed was never taken up either.
 * - No invitation at all → allow. This is the seeded administrator and any
 *   login made before the invite flow existed. They hold a password that was
 *   set deliberately, and locking them out on the strength of a missing row
 *   would take down the only account that can issue invitations.
 */
export async function hasUnacceptedInvitation(
  prisma: ExtendedPrismaClient,
  email: string,
): Promise<boolean> {
  const user = await prisma.user.findFirst({
    where: { email },
    // The soft-delete extension scopes this to live invitations for free.
    select: { invitations: { select: { acceptedAt: true } } },
  });

  if (!user || user.invitations.length === 0) {
    return false;
  }

  return !user.invitations.some((invitation) => invitation.acceptedAt !== null);
}

/** What the invitee is told when the gate closes on them. */
export const UNACCEPTED_INVITATION_MESSAGE =
  'This account has not been activated yet. Use the invite link that was emailed to you, or ask an administrator to resend it.';
