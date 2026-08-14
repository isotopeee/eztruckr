import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@eztruckr/db';
import {
  INVITATION_TTL_DAYS,
  invitationStatus,
  InvitationStatus,
  type InvitationPreview,
  type StaffInvitation,
} from '@eztruckr/types';
import { AuthService } from '../auth/auth.service';
import type { Env } from '../config/env-schema';
import { invitationEmail } from '../mail/invitation-email';
import { MailService } from '../mail/mail.service';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';

type InvitationRow = Prisma.StaffInvitationGetPayload<Record<string, never>>;

/** 32 bytes of CSPRNG, base64url. Guessing one is not a threat model. */
const TOKEN_BYTES = 32;

/**
 * Provisioning a login is two facts that must not drift apart: an account with
 * no usable password, and a link that is the only way to give it one.
 *
 * WHY THE TOKEN IS HASHED AT REST. The plaintext is generated here, put in one
 * email, and never persisted. `tokenHash` is a SHA-256 of it, so a database
 * dump — or an administrator with read access to the table — yields nothing
 * that can be accepted. Lookup is by hash, which is why the unique index is on
 * the hash and not the token.
 *
 * NO SALT AND NO KDF, deliberately, which is the opposite of the rule for
 * passwords. A password is low-entropy and needs slowing down; this token is 32
 * random bytes, so there is nothing to brute-force and a per-row salt would only
 * make lookup a table scan.
 */
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get invitations() {
    return this.prisma.client.staffInvitation;
  }

  /**
   * Mint an invitation for a login and email it.
   *
   * Revoking first is not tidiness — `staff_invitation_pending_user_live_key`
   * refuses a second pending row, so a resend that did not revoke would fail on
   * the index. Doing it in one transaction is what stops a crash between the
   * two leaving an account with no way in and no pending invite to resend.
   */
  async issue(userId: string): Promise<StaffInvitation> {
    const user = await this.prisma.client.user.findFirst({ where: { id: userId } });

    if (!user) {
      throw new NotFoundException(`No user with id ${userId}`);
    }

    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invitation = await this.prisma.client.$transaction(async (tx) => {
      await tx.staffInvitation.updateMany({
        where: { userId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      return tx.staffInvitation.create({
        data: { userId, tokenHash: hashToken(token), expiresAt },
      });
    });

    // Sent AFTER the transaction commits. Inside it, a slow SMTP call would
    // hold a write transaction open, and a rollback would leave a link in
    // somebody's inbox pointing at an invitation that no longer exists.
    const delivery = await this.mail.send(
      invitationEmail({ to: user.email, name: user.name, url: this.acceptUrl(token) }),
    );

    const recorded = await this.invitations.update({
      where: { id: invitation.id },
      data: delivery.sent
        ? { sentAt: new Date(), deliveryError: null }
        : { sentAt: null, deliveryError: delivery.error },
    });

    return toInvitation(recorded);
  }

  /** The pending or most recent invitation for a login, for the admin screen. */
  async latestFor(userId: string): Promise<StaffInvitation | null> {
    const row = await this.invitations.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return row ? toInvitation(row) : null;
  }

  async latestForMany(userIds: string[]): Promise<Map<string, StaffInvitation>> {
    if (userIds.length === 0) {
      return new Map();
    }

    // Ascending, so the last write for each user wins and the map ends up
    // holding the newest — one query rather than one per row on the list.
    const rows = await this.invitations.findMany({
      where: { userId: { in: userIds } },
      orderBy: { createdAt: 'asc' },
    });

    return new Map(rows.map((row) => [row.userId, toInvitation(row)]));
  }

  /**
   * What the accept page may know before a password is set.
   *
   * A bad token and an expired one are told apart on purpose. There is nothing
   * to protect by conflating them — the invitee holds the link either way — and
   * "this invite expired, ask for a new one" is actionable where "not found" is
   * a dead end.
   */
  async preview(token: string): Promise<InvitationPreview> {
    const { invitation, user } = await this.resolveUsable(token);

    return {
      email: user.email,
      name: user.name,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Take up the invitation: set the password, and only then mark it used.
   *
   * ORDER MATTERS. If the password write fails, the invitation is still
   * pending and the link still works. The reverse order would burn the token on
   * a failure and lock the person out of an account they were just invited to,
   * with no way back except an administrator resending.
   *
   * `emailVerified` is written here rather than at creation because this is the
   * moment it becomes true: following a link sent to that address is the proof.
   * The old flow set it optimistically at provisioning time, when nothing had
   * been verified at all.
   */
  async accept(token: string, password: string): Promise<void> {
    const { invitation, user } = await this.resolveUsable(token);

    const context = await this.auth.instance.$context;
    const hash = await context.password.hash(password);
    await context.internalAdapter.updatePassword(user.id, hash);

    await this.prisma.client.$transaction(async (tx) => {
      await tx.staffInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      await tx.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });
    });
  }

  /** Withdraw a pending invite. Accepted ones are history and stay put. */
  async revoke(userId: string): Promise<StaffInvitation> {
    const row = await this.invitations.findFirst({
      where: { userId, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (!row) {
      throw new NotFoundException('There is no pending invitation for this login');
    }

    return toInvitation(
      await this.invitations.update({ where: { id: row.id }, data: { revokedAt: new Date() } }),
    );
  }

  // -------------------------------------------------------------------------

  private acceptUrl(token: string): string {
    const base = this.config.get('APP_BASE_URL', { infer: true }).replace(/\/+$/, '');

    return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
  }

  private async resolveUsable(token: string) {
    const invitation = await this.invitations.findFirst({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });

    if (!invitation) {
      throw new NotFoundException('This invitation link is not valid');
    }

    const status = invitationStatus(
      {
        acceptedAt: dateToIso(invitation.acceptedAt),
        revokedAt: dateToIso(invitation.revokedAt),
        expiresAt: invitation.expiresAt.toISOString(),
      },
      new Date(),
    );

    if (status !== InvitationStatus.PENDING) {
      // 410 rather than 404: the link was real, and the page can say which of
      // the three things happened to it.
      throw new GoneException(EXHAUSTED_MESSAGES[status]);
    }

    if (!invitation.user.isActive) {
      throw new BadRequestException('This account has been deactivated');
    }

    return { invitation, user: invitation.user };
  }
}

const EXHAUSTED_MESSAGES: Record<Exclude<InvitationStatus, 'PENDING'>, string> = {
  [InvitationStatus.ACCEPTED]: 'This invitation has already been used. Try signing in instead.',
  [InvitationStatus.REVOKED]: 'This invitation was withdrawn. Ask an administrator for a new one.',
  [InvitationStatus.EXPIRED]: 'This invitation has expired. Ask an administrator for a new one.',
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toInvitation(row: InvitationRow): StaffInvitation {
  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt.toISOString(),
    acceptedAt: dateToIso(row.acceptedAt),
    revokedAt: dateToIso(row.revokedAt),
    sentAt: dateToIso(row.sentAt),
    deliveryError: row.deliveryError,
    ...auditFields(row),
  };
}
