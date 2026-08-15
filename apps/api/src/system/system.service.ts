import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { getActorId, withActor } from '@eztruckr/db';
import type { InitializeSystemInput, SystemStatus } from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from '../users/invitations.service';
import { UsersService } from '../users/users.service';

/** The settings row's own id; there is exactly one. */
const SINGLETON_ID = 'singleton';

export const ALREADY_INITIALIZED_MESSAGE =
  'This system has already been set up. Sign in, or ask an administrator to invite you.';

/**
 * First-run setup: the one moment an account can be created without one.
 *
 * `POST /system/initialize` is PUBLIC and it makes an ADMINISTRATOR. That is
 * as dangerous as it sounds, and the only thing standing in front of it is
 * `system_setting.initializedAt` being null. Everything below exists to make
 * that check impossible to race, and permanent once it has passed.
 *
 * WHY NOT "ARE THERE ANY USERS?". It is the obvious test and it is unsafe:
 * deleting or deactivating the last administrator would reopen a public
 * endpoint that mints new ones. The flag is written once and never cleared, so
 * a system that has been set up stays set up even if every account is later
 * removed. Recovering from that is an operator's job with database access, not
 * something the front door should offer.
 */
@Injectable()
export class SystemService {
  private readonly logger = new Logger(SystemService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
  ) {}

  async status(): Promise<SystemStatus> {
    return { initialized: await this.isInitialized() };
  }

  /**
   * Create the first administrator and email them an invite.
   *
   * ORDER, and why it is this way round. The account has to exist before the
   * claim can be written, because `system_setting.createdBy` is NOT NULL by
   * CHECK and the administrator is the only actor there will ever be for it.
   * So: cheap pre-check, create, then claim atomically — and if the claim is
   * lost to a concurrent request, the account is soft-deleted again rather than
   * left behind as a second administrator nobody asked for.
   *
   * The pre-check is not the control; the claim is. It exists so the ordinary
   * "somebody refreshed the setup page" case answers 409 without creating and
   * destroying an account on the way.
   */
  async initialize(input: InitializeSystemInput): Promise<void> {
    if (await this.isInitialized()) {
      throw new ConflictException(ALREADY_INITIALIZED_MESSAGE);
    }

    const admin = await this.users.createBootstrapAdministrator(input);

    await this.assertTheInviteWasDelivered(admin.id);

    let claimed: boolean;
    try {
      claimed = await withActor({ userId: admin.id }, () => this.claimInitialization());
    } catch (error) {
      await this.undo(admin.id, 'claiming initialisation failed');
      throw error;
    }

    if (!claimed) {
      // Another request got there first, between the pre-check and here.
      await this.undo(admin.id, 'another request initialised the system first');
      throw new ConflictException(ALREADY_INITIALIZED_MESSAGE);
    }

    this.logger.log(`System initialised; ${admin.email} invited as administrator`);
  }

  // -------------------------------------------------------------------------

  private async isInitialized(): Promise<boolean> {
    const setting = await this.prisma.client.systemSetting.findFirst({
      where: { id: SINGLETON_ID },
      select: { initializedAt: true },
    });

    return setting?.initializedAt != null;
  }

  /**
   * Stamp `initializedAt`, and report whether WE were the one who did it.
   *
   * One statement, so the read and the write cannot be separated. Both cases
   * are covered: no settings row yet (fresh install) inserts one, and a row
   * that exists but is unstamped is updated only `WHERE "initializedAt" IS
   * NULL`. A concurrent caller therefore either conflicts on the primary key or
   * matches nothing, and `RETURNING` gives us zero rows either way.
   *
   * Raw SQL because Prisma has no way to express `ON CONFLICT ... DO UPDATE ...
   * WHERE`, and expressing it as read-then-write would reintroduce exactly the
   * race this is here to close.
   *
   * `createdBy`/`updatedBy` are written explicitly because the audit extension
   * does not see raw SQL — it hooks Prisma's model methods, and this is not
   * one. The actor still comes from the caller's `withActor` scope, so the
   * value is the same one the extension would have filled in.
   */
  private async claimInitialization(): Promise<boolean> {
    const actorId = this.currentActorId();

    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      INSERT INTO "system_setting" ("id", "initializedAt", "createdAt", "updatedAt", "createdBy")
      VALUES (${SINGLETON_ID}, NOW(), NOW(), NOW(), ${actorId}::uuid)
      ON CONFLICT ("id") DO UPDATE
        SET "initializedAt" = NOW(),
            "updatedAt" = NOW(),
            "updatedBy" = ${actorId}::uuid
        WHERE "system_setting"."initializedAt" IS NULL
      RETURNING "id"
    `;

    return rows.length > 0;
  }

  /**
   * The actor for the claim, which is always the administrator being created.
   *
   * Read back out of the async-local scope rather than passed down, so this
   * cannot be called meaningfully from outside one — the `??` throw is
   * unreachable through `initialize` and is here to keep it that way.
   */
  private currentActorId(): string {
    const id = getActorId();

    if (!id) {
      throw new Error('claimInitialization must run inside withActor()');
    }

    return id;
  }

  /**
   * THE ONE INVITATION NOBODY CAN RESEND, which is why this is here and why it
   * is here rather than in `InvitationsService`.
   *
   * A failed delivery is normally recorded rather than raised: `issue()` writes
   * `deliveryError` to the row, the Users screen shows it, and an administrator
   * clicks resend. That is right for every invitation except this one — the
   * administrator who would do the resending is the account whose invite just
   * failed, and there is no password anywhere to fall back on.
   *
   * Without this check the endpoint answered 204, stamped `initializedAt`, and
   * left an installation with an administrator nobody could activate and a
   * `/setup` that refuses to run twice. The token is stored hashed, so the link
   * could not be recovered from the database either: the only way out was
   * `psql`. Verified against a live stack with a deliberately invalid API key.
   *
   * Called BEFORE `claimInitialization`, so failing here leaves the flag
   * unstamped and `/setup` open. The rollback soft-deletes the account, and
   * `user_email_live_key` is partial (`WHERE "deletedAt" IS NULL`), so the same
   * address is free for the retry.
   *
   * The likely trigger in practice is not a mistyped key but an unverified
   * sending domain, which Resend refuses with a 403. The message repeats
   * whatever it said, because that text is the only diagnosis the operator gets.
   */
  private async assertTheInviteWasDelivered(userId: string): Promise<void> {
    const invitation = await this.invitations.latestFor(userId);

    if (invitation?.sentAt) {
      return;
    }

    const reason = invitation?.deliveryError ?? 'the invitation was never recorded as sent';
    await this.undo(userId, `the invitation could not be delivered: ${reason}`);

    throw new ServiceUnavailableException(
      `The administrator account could not be invited, because the email could not be sent: ${reason}. ` +
        'Nothing has been set up — fix the mail configuration and try again.',
    );
  }

  private async undo(userId: string, reason: string): Promise<void> {
    this.logger.warn(`Rolling back bootstrap administrator ${userId}: ${reason}`);
    await this.prisma.client.user.softDelete({ id: userId });
  }
}
