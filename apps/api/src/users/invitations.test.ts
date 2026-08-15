import { createHash } from 'node:crypto';
import { GoneException, NotFoundException } from '@nestjs/common';
import {
  createPrismaClient,
  testUuid,
  withActor,
  type ExtendedPrismaClient,
  withTriggersSuspended,
} from '@eztruckr/db';
import { INVITATION_TTL_DAYS, UserRole } from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuthService } from '../auth/auth.service';
import type { MailMessage, MailService } from '../mail/mail.service';
import type { PrismaService } from '../prisma/prisma.service';
import { hasUnacceptedInvitation } from './invitation-gate';
import { InvitationsService } from './invitations.service';

/**
 * A provisioned login is taken up by its owner, and only once.
 *
 * These are the assertions the whole flow rests on, and most of them are about
 * what must NOT work: a used link, an expired one, a withdrawn one, and a
 * database row that could be turned back into a working link.
 *
 * Block `00000007`. Deliberately not a string prefix — see `testUuid`.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let invitations: InvitationsService;

let adminId: string;

/** Every message the stubbed transport was handed, newest last. */
let outbox: MailMessage[];
/** Flipped by a test to make the next send fail. */
let deliveryFailure: string | null;

const PREFIX = '00000007-';
const id = (name: string) => testUuid('00000007', name);

const INVITEE_ID = id('invitee');
const INVITEE_EMAIL = 'invitee@eztruckr.test';

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    // Invitations cascade from the user, but the delete is explicit so a
    // failure here is a failure here rather than a surprise two tests later.
    await tx.$executeRawUnsafe(
      `DELETE FROM "staff_invitation" WHERE "userId"::text LIKE '${PREFIX}%'`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "account" WHERE "userId"::text LIKE '${PREFIX}%'`);
    await tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

/**
 * The password path, stubbed.
 *
 * `accept()` calls Better Auth to hash and store the password. Standing a real
 * instance up here would drag in the whole auth config to assert something
 * these tests are not about — that Better Auth hashes passwords. What IS worth
 * asserting is that accept calls it exactly once, with the password given, and
 * only after the invitation was found usable.
 */
const passwordWrites: Array<{ userId: string; hash: string }> = [];

const authStub = {
  instance: {
    $context: Promise.resolve({
      password: { hash: (value: string) => Promise.resolve(`hashed:${value}`) },
      internalAdapter: {
        updatePassword: (userId: string, hash: string) => {
          passwordWrites.push({ userId, hash });
          return Promise.resolve();
        },
      },
    }),
  },
} as unknown as AuthService;

const mailStub = {
  send: (message: MailMessage) => {
    outbox.push(message);
    return Promise.resolve(
      deliveryFailure ? { sent: false as const, error: deliveryFailure } : { sent: true as const },
    );
  },
} as unknown as MailService;

const configStub = {
  get: (key: string) => (key === 'APP_BASE_URL' ? 'http://localhost:3000' : undefined),
} as never;

/** The token as it appears in the emailed link. */
function tokenFromLastEmail(): string {
  const link = outbox.at(-1)?.text.match(/accept-invite\?token=([^\s]+)/);
  if (!link?.[1]) throw new Error('No invite link in the last email');
  return decodeURIComponent(link[1]);
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[invitations] database unreachable — skipping integration tests');
    return;
  }

  const admin = await prisma.user.findFirst({ where: { email: 'admin@eztruckr.ph' } });
  if (!admin) throw new Error('Seed the database first: pnpm db:seed');
  adminId = admin.id;

  invitations = new InvitationsService(
    { client: prisma } as unknown as PrismaService,
    authStub,
    mailStub,
    configStub,
  );
});

afterAll(async () => {
  if (available) await cleanup();
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!available) return;

  outbox = [];
  deliveryFailure = null;
  passwordWrites.length = 0;

  await cleanup();

  await withActor({ userId: adminId }, async () => {
    await prisma.user.create({
      data: {
        id: INVITEE_ID,
        email: INVITEE_EMAIL,
        name: 'Invited Person',
        // An office role that needs no staff link, so the fixture is a login
        // the app would also consider valid. A dispatcher would now need one.
        role: UserRole.ACCOUNTING,
        emailVerified: false,
      },
    });
  });
});

const issue = () => withActor({ userId: adminId }, () => invitations.issue(INVITEE_ID));

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('issuing an invitation', () => {
  it('emails a link and records that it went out', async () => {
    if (!available) return;

    const invitation = await issue();

    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.to).toBe(INVITEE_EMAIL);
    expect(outbox[0]?.text).toContain('accept-invite?token=');
    expect(invitation.sentAt).not.toBeNull();
    expect(invitation.deliveryError).toBeNull();
  });

  /**
   * THE TOKEN IS NOT IN THE DATABASE. A dump, or an administrator reading the
   * table, must not yield anything that can be accepted — which is the whole
   * reason `tokenHash` exists rather than a `token` column.
   */
  it('stores only a hash of the token', async () => {
    if (!available) return;

    await issue();
    const token = tokenFromLastEmail();

    const row = await prisma.staffInvitation.findFirstOrThrow({
      where: { userId: INVITEE_ID },
    });

    expect(row.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it('expires the link after the stated number of days', async () => {
    if (!available) return;

    const invitation = await issue();
    const days = (new Date(invitation.expiresAt).getTime() - Date.now()) / 86_400_000;

    expect(days).toBeGreaterThan(INVITATION_TTL_DAYS - 0.01);
    expect(days).toBeLessThan(INVITATION_TTL_DAYS + 0.01);
  });

  /**
   * A failed send leaves a VALID invitation. The token is already minted, so
   * the fix is to resend rather than to delete the person and start again —
   * and the error is recorded so the screen can say which happened.
   */
  it('keeps the invitation when the email fails, and records why', async () => {
    if (!available) return;

    deliveryFailure = 'The domain is not verified';
    const invitation = await issue();

    expect(invitation.sentAt).toBeNull();
    expect(invitation.deliveryError).toBe('The domain is not verified');

    // Still usable: the link works even though the mail did not go out.
    await expect(invitations.preview(tokenFromLastEmail())).resolves.toMatchObject({
      email: INVITEE_EMAIL,
    });
  });

  /**
   * Resending must invalidate the old link, not merely add a second one.
   * `staff_invitation_pending_user_live_key` refuses two pending rows, so a
   * resend that forgot to revoke would fail on the index rather than quietly
   * leaving two live links — but the behaviour is asserted here too, because
   * the index protects the invariant and this protects the intent.
   */
  it('revokes the previous link when a new one is sent', async () => {
    if (!available) return;

    await issue();
    const firstToken = tokenFromLastEmail();

    await issue();
    const secondToken = tokenFromLastEmail();

    expect(secondToken).not.toBe(firstToken);
    await expect(invitations.preview(firstToken)).rejects.toBeInstanceOf(GoneException);
    await expect(invitations.preview(secondToken)).resolves.toMatchObject({
      email: INVITEE_EMAIL,
    });
  });
});

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('accepting one', () => {
  it('sets the password and verifies the address', async () => {
    if (!available) return;

    await issue();
    await invitations.accept(tokenFromLastEmail(), 'a-perfectly-fine-password');

    expect(passwordWrites).toEqual([
      { userId: INVITEE_ID, hash: 'hashed:a-perfectly-fine-password' },
    ]);

    const user = await prisma.user.findFirstOrThrow({ where: { id: INVITEE_ID } });
    // Following a link sent to that address is the proof. Provisioning was not.
    expect(user.emailVerified).toBe(true);
  });

  it('cannot be used twice', async () => {
    if (!available) return;

    await issue();
    const token = tokenFromLastEmail();

    await invitations.accept(token, 'a-perfectly-fine-password');

    await expect(invitations.accept(token, 'another-fine-password')).rejects.toBeInstanceOf(
      GoneException,
    );
    // And the second attempt wrote nothing.
    expect(passwordWrites).toHaveLength(1);
  });

  it('refuses an expired link', async () => {
    if (!available) return;

    await issue();
    const token = tokenFromLastEmail();

    await prisma.staffInvitation.updateMany({
      where: { userId: INVITEE_ID },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(invitations.accept(token, 'a-perfectly-fine-password')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(passwordWrites).toHaveLength(0);
  });

  it('refuses a withdrawn link', async () => {
    if (!available) return;

    await issue();
    const token = tokenFromLastEmail();

    await withActor({ userId: adminId }, () => invitations.revoke(INVITEE_ID));

    await expect(invitations.accept(token, 'a-perfectly-fine-password')).rejects.toBeInstanceOf(
      GoneException,
    );
    expect(passwordWrites).toHaveLength(0);
  });

  it('refuses a token that was never issued', async () => {
    if (!available) return;

    await expect(
      invitations.accept('not-a-real-token', 'a-perfectly-fine-password'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * A near-miss must not work. The lookup is by hash of the whole token, so a
   * prefix hashes to something else entirely — this pins that nothing is doing
   * a `startsWith` or a partial match anywhere in the path.
   */
  it('refuses a truncated token', async () => {
    if (!available) return;

    await issue();
    const token = tokenFromLastEmail();

    await expect(
      invitations.accept(token.slice(0, -1), 'a-perfectly-fine-password'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('the sign-in gate', () => {
  it('closes on an account whose invite is still pending', async () => {
    if (!available) return;

    await issue();

    expect(await hasUnacceptedInvitation(prisma, INVITEE_EMAIL)).toBe(true);
  });

  it('opens once the invite is accepted', async () => {
    if (!available) return;

    await issue();
    await invitations.accept(tokenFromLastEmail(), 'a-perfectly-fine-password');

    expect(await hasUnacceptedInvitation(prisma, INVITEE_EMAIL)).toBe(false);
  });

  /**
   * REVOKING MUST ALSO SHUT THE ACCOUNT. Withdrawing a link while leaving the
   * login reachable would make revocation cosmetic — this is the assertion that
   * says the gate covers the whole account and not just one pending row.
   */
  it('stays closed after the invite is withdrawn', async () => {
    if (!available) return;

    await issue();
    await withActor({ userId: adminId }, () => invitations.revoke(INVITEE_ID));

    expect(await hasUnacceptedInvitation(prisma, INVITEE_EMAIL)).toBe(true);
  });

  /**
   * The seeded administrator has no invitation and a password that was set
   * deliberately. Locking them out on the strength of a missing row would take
   * down the only account that can issue invitations at all.
   */
  it('leaves a login that predates the invite flow alone', async () => {
    if (!available) return;

    expect(await hasUnacceptedInvitation(prisma, 'admin@eztruckr.ph')).toBe(false);
  });
});

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('withdrawing one', () => {
  it('refuses when there is nothing pending', async () => {
    if (!available) return;

    await issue();
    await invitations.accept(tokenFromLastEmail(), 'a-perfectly-fine-password');

    await expect(
      withActor({ userId: adminId }, () => invitations.revoke(INVITEE_ID)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * An accepted invitation is history. Revoking must not reach back and rewrite
   * it — `staff_invitation_outcome_exclusive` would refuse the write anyway,
   * which is the point of having the CHECK.
   */
  it('leaves an accepted invitation untouched', async () => {
    if (!available) return;

    await issue();
    await invitations.accept(tokenFromLastEmail(), 'a-perfectly-fine-password');

    const row = await prisma.staffInvitation.findFirstOrThrow({ where: { userId: INVITEE_ID } });
    expect(row.acceptedAt).not.toBeNull();
    expect(row.revokedAt).toBeNull();
  });
});

/**
 * The database refuses a row that claims both outcomes, whatever the service
 * does. Asserted directly, because every service path above is written to avoid
 * it and none of them would notice if the CHECK were dropped.
 */
describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('what the schema refuses', () => {
  it('will not store an invitation that was both accepted and revoked', async () => {
    if (!available) return;

    await issue();

    await expect(
      prisma.staffInvitation.updateMany({
        where: { userId: INVITEE_ID },
        data: { acceptedAt: new Date(), revokedAt: new Date() },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => String(error).includes('staff_invitation_outcome_exclusive'),
      'expected staff_invitation_outcome_exclusive to reject the write',
    );
  });

  it('will not store a delivery that both succeeded and failed', async () => {
    if (!available) return;

    await issue();

    await expect(
      prisma.staffInvitation.updateMany({
        where: { userId: INVITEE_ID },
        data: { sentAt: new Date(), deliveryError: 'both at once' },
      }),
    ).rejects.toSatisfy(
      (error: unknown) => String(error).includes('staff_invitation_delivery_exclusive'),
      'expected staff_invitation_delivery_exclusive to reject the write',
    );
  });
});
