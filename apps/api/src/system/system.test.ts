import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import {
  createPrismaClient,
  testUuid,
  withActor,
  type ExtendedPrismaClient,
  withTriggersSuspended,
} from '@eztruckr/db';
import { UserRole } from '@eztruckr/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import type { InvitationsService } from '../users/invitations.service';
import type { UsersService } from '../users/users.service';
import { SystemService } from './system.service';

/**
 * Setting a system up, and — the part that matters — never doing it twice.
 *
 * `POST /system/initialize` is public and creates an ADMINISTRATOR, so the flag
 * that closes it is the only thing between a stranger and the top of the
 * system. Most of what follows asserts that it stays closed: after a successful
 * setup, against a concurrent second request, and after every administrator has
 * been removed.
 *
 * Block `00000008`.
 */

let prisma: ExtendedPrismaClient;
let available = false;
let system: SystemService;

/** Users the fake provisioner made, so each test can assert and clean up. */
let provisioned: Array<{ id: string; email: string }>;

/**
 * Makes the race in `admits exactly one of two concurrent attempts` real.
 *
 * Without it the two `initialize` calls interleave however the event loop
 * happens to schedule them, and in practice the first finishes its claim before
 * the second runs its PRE-CHECK — so the second is refused by the cheap check
 * and the ATOMIC one is never exercised. A mutation that deleted the
 * `WHERE "initializedAt" IS NULL` guard still passed the test, which is how
 * this was found. Holding both callers here, after provisioning and before
 * claiming, leaves the guard as the only thing separating them.
 *
 * Zero means "no barrier": every other test runs straight through.
 */
let barrierSize = 0;
let waiting: Array<() => void> = [];

function waitAtBarrier(): Promise<void> {
  if (barrierSize === 0) return Promise.resolve();

  return new Promise<void>((resolve) => {
    waiting.push(resolve);

    if (waiting.length >= barrierSize) {
      const release = waiting;
      waiting = [];
      for (const resolveOne of release) resolveOne();
    }
  });
}

const PREFIX = '00000008-';
const id = (name: string) => testUuid('00000008', name);

/**
 * A stand-in for the real provisioning path.
 *
 * `UsersService.createBootstrapAdministrator` goes through Better Auth and the
 * mail transport, neither of which this file is about — `invitations.test.ts`
 * covers that an invite is minted and sent. What IS under test here is the
 * claim: whether the administrator is created at all, and whether it survives.
 * So this writes the user row directly and records what it did.
 */
/**
 * Whether the stubbed transport managed to deliver. Only the delivery test
 * touches it; `beforeEach` puts it back.
 */
let deliverySucceeds = true;

/**
 * Stands in for the invitation `createBootstrapAdministrator` would have
 * minted. The real one is covered by `invitations.test.ts`; what matters here
 * is only whether it went out, because that is what `initialize` now refuses on.
 */
function invitationsStub(): InvitationsService {
  return {
    latestFor: async (userId: string) => ({
      id: id(`invitation-${userId}`),
      userId,
      sentAt: deliverySucceeds ? new Date().toISOString() : null,
      deliveryError: deliverySucceeds ? null : '403 The domain is not verified',
    }),
  } as unknown as InvitationsService;
}

function usersStub(): UsersService {
  return {
    createBootstrapAdministrator: async (input: { email: string; name: string }) => {
      const created = await prisma.user.create({
        data: {
          // Unique per CALL, not per email. A rolled-back attempt soft-deletes
          // its user, and the retry is allowed to reuse the address — so the
          // same email legitimately provisions twice in one test, and a
          // deterministic id would collide on the primary key rather than on
          // the partial unique this is meant to exercise.
          id: id(`${input.email}-${provisioned.length}`),
          email: input.email,
          name: input.name,
          role: UserRole.ADMINISTRATOR,
          emailVerified: false,
        },
      });

      provisioned.push({ id: created.id, email: created.email });

      // Past the pre-check, not yet at the claim — the one point where the
      // atomic guard is the only thing left. A no-op unless a test asked.
      await waitAtBarrier();

      return { id: created.id, email: created.email } as never;
    },
  } as unknown as UsersService;
}

async function cleanup(): Promise<void> {
  await withTriggersSuspended(prisma, async (tx) => {
    await tx.$executeRawUnsafe(
      `DELETE FROM "staff_invitation" WHERE "userId"::text LIKE '${PREFIX}%'`,
    );
    await tx.$executeRawUnsafe(`DELETE FROM "user" WHERE id::text LIKE '${PREFIX}%'`);
  });
}

/**
 * The seeded test database is already initialised, so every test here starts by
 * putting it back to "never set up" and restores it afterwards. Suites run
 * sequentially, so nothing else observes the gap.
 */
async function setInitialized(value: boolean): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "system_setting" SET "initializedAt" = ${value ? 'NOW()' : 'NULL'}`,
  );
}

beforeAll(async () => {
  prisma = createPrismaClient();

  try {
    await prisma.$queryRaw`SELECT 1`;
    available = true;
  } catch {
    console.warn('[system] database unreachable — skipping integration tests');
    return;
  }

  system = new SystemService(
    { client: prisma } as unknown as PrismaService,
    usersStub(),
    invitationsStub(),
  );
});

afterAll(async () => {
  if (available) {
    await cleanup();
    // Leave the shared fixture as we found it.
    await setInitialized(true);
  }
  await prisma.$disconnect();
});

beforeEach(async () => {
  if (!available) return;
  provisioned = [];
  barrierSize = 0;
  waiting = [];
  deliverySucceeds = true;
  await cleanup();
  await setInitialized(false);
});

const initialize = (email = 'first.admin@eztruckr.test') =>
  system.initialize({ email, name: 'First Administrator' });

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('reporting whether setup has happened', () => {
  it('says no on a system that has never been set up', async () => {
    if (!available) return;

    await expect(system.status()).resolves.toEqual({ initialized: false });
  });

  it('says yes once it has', async () => {
    if (!available) return;

    await initialize();

    await expect(system.status()).resolves.toEqual({ initialized: true });
  });
});

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('setting a system up', () => {
  it('creates the administrator and stamps the flag', async () => {
    if (!available) return;

    await initialize();

    expect(provisioned).toHaveLength(1);

    const setting = await prisma.systemSetting.findFirstOrThrow();
    expect(setting.initializedAt).not.toBeNull();

    // Attributed to the administrator themselves — the only party there is.
    // WHICH column it lands in depends on the path: a fresh install inserts the
    // settings row and writes `createdBy`, while a database that already had
    // one (this test database, which is seeded) takes the ON CONFLICT branch
    // and writes `updatedBy`. Both are the same fact, so assert the fact.
    expect([setting.createdBy, setting.updatedBy]).toContain(provisioned[0]?.id);
  });

  it('refuses a second time', async () => {
    if (!available) return;

    await initialize();

    await expect(initialize('second.admin@eztruckr.test')).rejects.toBeInstanceOf(
      ConflictException,
    );
    // And created nothing on the way to refusing.
    expect(provisioned).toHaveLength(1);
  });

  /**
   * THE RACE. Two requests both pass the pre-check, both create an
   * administrator, and exactly one may keep it. Run concurrently rather than in
   * sequence, because a read-then-write implementation passes the sequential
   * version and loses this one.
   */
  it('admits exactly one of two concurrent attempts', async () => {
    if (!available) return;

    // Both must be past the pre-check before either claims — otherwise this
    // passes on the cheap check and proves nothing about the atomic one.
    barrierSize = 2;

    const results = await Promise.allSettled([
      initialize('race.one@eztruckr.test'),
      initialize('race.two@eztruckr.test'),
    ]);

    const won = results.filter((result) => result.status === 'fulfilled');
    const lost = results.filter((result) => result.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    // The loser's account is rolled back, not left as a second administrator.
    const live = await prisma.user.count({
      where: { id: { in: provisioned.map((entry) => entry.id) } },
    });
    expect(live).toBe(1);
  });

  /**
   * THE ONE INVITATION NOBODY CAN RESEND.
   *
   * A delivery failure is recorded rather than raised everywhere else, because
   * an administrator can see it and click resend. Here the administrator IS the
   * failed invite. Answering 204 and stamping the flag left an installation
   * with an account nobody could activate and a `/setup` that refuses to run
   * twice — recoverable only through psql, since the token is stored hashed.
   *
   * Found by running the production stack with an invalid Resend key, not by
   * reading the code: every layer behaved exactly as designed.
   */
  it('rolls back and stays open when the invitation cannot be delivered', async () => {
    if (!available) return;

    deliverySucceeds = false;

    await expect(initialize()).rejects.toBeInstanceOf(ServiceUnavailableException);

    // The flag is untouched, so the operator gets another go.
    await expect(system.status()).resolves.toEqual({ initialized: false });

    // And the half-made administrator did not survive.
    const live = await prisma.user.count({
      where: { id: { in: provisioned.map((entry) => entry.id) } },
    });
    expect(live).toBe(0);
  });

  /**
   * The rollback has to free the ADDRESS, not just the row — the operator will
   * retry with the same one. `user_email_live_key` is partial
   * (`WHERE "deletedAt" IS NULL`), which is what makes that work.
   */
  it('lets the same address be used again once mail is fixed', async () => {
    if (!available) return;

    deliverySucceeds = false;
    await expect(initialize()).rejects.toBeInstanceOf(ServiceUnavailableException);

    deliverySucceeds = true;
    await expect(initialize()).resolves.toBeUndefined();

    await expect(system.status()).resolves.toEqual({ initialized: true });

    // Two attempts, and exactly one live administrator to show for them.
    const live = await prisma.user.count({
      where: { id: { in: provisioned.map((entry) => entry.id) } },
    });
    expect(provisioned).toHaveLength(2);
    expect(live).toBe(1);
  });

  /**
   * The reason the flag is STORED rather than derived from "does an
   * administrator exist". Deriving it would reopen a public
   * administrator-creation endpoint the moment the last one was removed.
   */
  it('stays closed after every administrator is gone', async () => {
    if (!available) return;

    await initialize();

    await withActor({ userId: provisioned[0]!.id }, () =>
      prisma.user.softDelete({ id: provisioned[0]!.id }),
    );

    await expect(system.status()).resolves.toEqual({ initialized: true });
    await expect(initialize('opportunist@eztruckr.test')).rejects.toBeInstanceOf(ConflictException);
  });
});
