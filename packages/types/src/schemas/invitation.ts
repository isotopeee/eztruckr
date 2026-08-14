import { z } from 'zod';
import { auditFieldsSchema, passwordSchema } from './common';

/**
 * How long an invite link is good for.
 *
 * Long enough to survive a weekend and a forwarded email; short enough that a
 * link sitting in an ex-employee's inbox stops working. Stated here rather than
 * in the service so the web app can say "expires in 7 days" without guessing.
 */
export const INVITATION_TTL_DAYS = 7;

/**
 * What an invitation is, from the outside.
 *
 * NO TOKEN FIELD, deliberately. The plaintext token exists in exactly two
 * places — the email that carried it, and the URL the invitee is holding — and
 * the API never reads one back out. An administrator can resend or revoke; they
 * cannot retrieve a link and accept on somebody else's behalf.
 */
export const staffInvitationSchema = auditFieldsSchema.extend({
  id: z.string(),
  userId: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  deliveryError: z.string().nullable(),
});

export type StaffInvitation = z.infer<typeof staffInvitationSchema>;

/**
 * Where an invitation stands. DERIVED, NEVER STORED — the same rule the rest of
 * the schema follows for `recognisedCost` and `commissionsStale`. A stored
 * status column would need a job to flip PENDING to EXPIRED at midnight, and
 * would be wrong in the window before it ran.
 */
export const InvitationStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;

export type InvitationStatus = (typeof InvitationStatus)[keyof typeof InvitationStatus];

/**
 * Order matters: an invite that was accepted stays ACCEPTED after its
 * expiry date passes, because what happened outranks what lapsed.
 */
export function invitationStatus(
  invitation: Pick<StaffInvitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>,
  now: Date = new Date(),
): InvitationStatus {
  if (invitation.acceptedAt) {
    return InvitationStatus.ACCEPTED;
  }
  if (invitation.revokedAt) {
    return InvitationStatus.REVOKED;
  }
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) {
    return InvitationStatus.EXPIRED;
  }
  return InvitationStatus.PENDING;
}

export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  [InvitationStatus.PENDING]: 'Invited',
  [InvitationStatus.ACCEPTED]: 'Active',
  [InvitationStatus.REVOKED]: 'Invite revoked',
  [InvitationStatus.EXPIRED]: 'Invite expired',
};

/**
 * What the accept page needs before it will show a password form.
 *
 * Name and email are echoed back so the invitee can see whose account they are
 * about to take over — a link forwarded to the wrong person should be obvious
 * before a password is set, not after.
 */
export const invitationPreviewSchema = z.object({
  email: z.string(),
  name: z.string(),
  expiresAt: z.string(),
});

export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

export const acceptInvitationSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;
