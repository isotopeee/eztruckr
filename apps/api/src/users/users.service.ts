import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { liveOne, withActor, type Prisma } from '@eztruckr/db';
import {
  STAFF_LINK_MESSAGE,
  hasStaffLinkMatchingRole,
  roleRequiresStaffLink,
  isUserRole,
  UserRole,
  type CreateUserInput,
  type MasterDataListQuery,
  type Page,
  type RemovalResult,
  type SessionUser,
  type StaffInvitation,
  type UpdateUserInput,
  type User,
} from '@eztruckr/types';
import { isAPIError } from 'better-auth/api';
import { AuthService } from '../auth/auth.service';
import type { RequestUser } from '../auth/request-user';
import { removeRecord } from '../master-data/removal';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from './invitations.service';

type UserRow = Prisma.UserGetPayload<Record<string, never>>;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly invitations: InvitationsService,
  ) {}

  private get users() {
    return this.prisma.client.user;
  }

  async list(query: MasterDataListQuery): Promise<Page<User>> {
    const where: Prisma.UserWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { email: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.users.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.users.count({ where }),
    ]);

    // One extra query for the whole page rather than one per row.
    const invitations = await this.invitations.latestForMany(rows.map((row) => row.id));

    return {
      items: rows.map((row) => toUser(row, invitations.get(row.id) ?? null)),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<User> {
    const row = await this.users.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No user with id ${id}`);
    }

    return toUser(row, await this.invitations.latestFor(id));
  }

  /**
   * The caller as the app needs to know them, including the display name from
   * their profile.
   *
   * `liveOne` is what makes `profiles` read as the one-to-one it actually is:
   * the partial unique index guarantees at most one undeleted profile, and the
   * soft-delete extension has already filtered the rest.
   */
  async currentUser(user: RequestUser): Promise<SessionUser> {
    const row = await this.users.findFirst({
      where: { id: user.id },
      include: { profiles: true },
    });

    if (!row) {
      throw new NotFoundException('Your account no longer exists');
    }

    const profile = liveOne(row.profiles, 'user profile');

    return {
      id: row.id,
      email: row.email,
      name: row.name,
      role: user.role,
      isActive: row.isActive,
      staffId: row.staffId,
      displayName: profile?.displayName ?? null,
    };
  }

  /**
   * Provision a login and invite its owner to take it up.
   *
   * Three steps, in this order and not another.
   *
   * 1. Better Auth creates the account, because the security-critical columns
   *    are `input: false` in its config and cannot be set through it — exactly
   *    the property that stops a request body choosing its own role. The
   *    account therefore starts at the least privilege in the system.
   * 2. The real role is written through Prisma. If this fails the account is
   *    soft-deleted rather than left behind as a login nobody meant to create.
   * 3. An invitation is minted and emailed.
   *
   * THE PASSWORD HERE IS DISCARDED AND IS NOT A CREDENTIAL. Better Auth's
   * sign-up requires one, so 32 random bytes are generated, handed over, and
   * dropped — nobody, including this process, retains it. It exists only so the
   * `account` row is shaped the way `updatePassword` expects when the invitee
   * accepts. Two independent things stop it from being a way in: nothing knows
   * it, and `hasUnacceptedInvitation` refuses sign-in until the invite is taken
   * up. Either alone would do; both is cheap.
   *
   * A FAILED EMAIL DOES NOT FAIL THE REQUEST. The account and the invitation
   * are both real at that point, and `deliveryError` records what happened, so
   * the fix is Resend on the users screen rather than deleting the person and
   * starting again. `MailService` returns a result instead of throwing for
   * exactly this reason.
   */
  async create(input: CreateUserInput): Promise<User> {
    await this.assertStaffLinkIsUsable(input.role, input.staffId);

    return this.provision(input, (id) => this.invitations.issue(id));
  }

  /**
   * Provision the FIRST administrator, during system initialisation.
   *
   * Shares `provision` with the ordinary path — same account shape, same
   * discarded password, same invite — and differs in exactly one way: WHO THE
   * ACTOR IS. There is no signed-in user during setup, and
   * `staff_invitation_created_by_required` will not accept a null, so the
   * invitation is written as the new administrator acting on their own behalf.
   * That is not a workaround for the CHECK, it is what actually happened: they
   * are the only party to the transaction.
   *
   * The user row itself is written OUTSIDE any actor scope, which is legal for
   * exactly this case — `user.createdBy` is the one audit column the schema
   * lets be null, because the bootstrap administrator genuinely has no creator.
   *
   * Callers must claim initialisation before calling this. It does not check,
   * because the check and the claim have to be the same atomic act and that
   * belongs to `SystemService`.
   */
  createBootstrapAdministrator(input: { email: string; name: string }): Promise<User> {
    return this.provision(
      { ...input, role: UserRole.ADMINISTRATOR, staffId: null, isActive: true },
      (id) => withActor({ userId: id }, () => this.invitations.issue(id)),
    );
  }

  /**
   * Create the account, apply its role, and invite its owner.
   *
   * `issueInvitation` is a parameter rather than a call because the two callers
   * differ only in which actor the invitation is attributed to — see
   * `createBootstrapAdministrator`. Everything else about provisioning is
   * identical and is stated once, here.
   */
  private async provision(
    input: {
      email: string;
      name: string;
      role: UserRole;
      staffId: string | null;
      isActive: boolean;
    },
    issueInvitation: (userId: string) => Promise<StaffInvitation>,
  ): Promise<User> {
    let createdId: string;

    try {
      const result = await this.auth.instance.api.signUpEmail({
        body: {
          email: input.email,
          password: randomBytes(32).toString('base64url'),
          name: input.name,
        },
      });
      createdId = result.user.id;
    } catch (error) {
      if (isAPIError(error)) {
        throw new ConflictException(error.message || 'That email address is already in use');
      }
      throw error;
    }

    try {
      const row = await this.users.update({
        where: { id: createdId },
        data: {
          role: input.role,
          staffId: input.staffId,
          isActive: input.isActive,
          // False until the invite is accepted. Following a link sent to that
          // address is the proof; provisioning is not.
          emailVerified: false,
        },
      });

      const invitation = await issueInvitation(createdId);

      return toUser(row, invitation);
    } catch (error) {
      this.logger.error(
        `Failed to finish provisioning user ${createdId}; soft-deleting the half-created account`,
        error instanceof Error ? error.stack : String(error),
      );
      await this.users.softDelete({ id: createdId });
      throw error;
    }
  }

  async update(id: string, input: UpdateUserInput): Promise<User> {
    const current = await this.get(id);

    const merged = {
      role: input.role ?? current.role,
      staffId: input.staffId === undefined ? current.staffId : input.staffId,
    };

    if (!hasStaffLinkMatchingRole(merged)) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'staffId', message: STAFF_LINK_MESSAGE }],
      });
    }

    await this.assertStaffLinkIsUsable(merged.role, merged.staffId);

    const row = await this.users.update({ where: { id }, data: input });

    return toUser(row, await this.invitations.latestFor(id));
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.get(id);

    // Better Auth owns password hashing and the account row it lives on;
    // reaching for the hash directly here would duplicate that and get it
    // wrong the first time the algorithm changes.
    const context = await this.auth.instance.$context;
    const hash = await context.password.hash(password);
    await context.internalAdapter.updatePassword(id, hash);
  }

  /**
   * A login that has never acted on anything can go. One that has — and every
   * audit column in the schema points back here — is deactivated, because
   * `createdBy` on a five-year-old shipment has to keep resolving to a name.
   */
  async remove(id: string, actor: RequestUser): Promise<RemovalResult> {
    await this.get(id);

    if (id === actor.id) {
      throw new BadRequestException('You cannot remove your own login');
    }

    const client = this.prisma.client;

    return removeRecord({
      probes: [
        {
          entity: 'records created',
          count: () => client.shipment.count({ where: { createdBy: id } }),
        },
        {
          entity: 'audit log entries',
          count: () => client.auditLog.count({ where: { actorId: id } }),
        },
        { entity: 'sessions', count: () => client.session.count({ where: { userId: id } }) },
      ],
      deactivate: () => this.users.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.users.softDelete({ id }),
    });
  }

  /**
   * A crew login is only meaningful if it points at a live crew member, and
   * only one login may point at each — the partial unique index enforces the
   * second half, but a clear message beats a 409 from an index name.
   */
  private async assertStaffLinkIsUsable(role: UserRole, staffId: string | null): Promise<void> {
    if (!roleRequiresStaffLink(role) || !staffId) {
      return;
    }

    const staff = await this.prisma.client.staff.findFirst({
      where: { id: staffId },
    });

    if (!staff) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'staffId', message: `No staff member with id ${staffId}` }],
      });
    }
  }
}

function toUser(row: UserRow, invitation: StaffInvitation | null): User {
  if (!isUserRole(row.role)) {
    throw new Error(`User ${row.id} has an unrecognised role code: ${row.role}`);
  }

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    isActive: row.isActive,
    emailVerified: row.emailVerified,
    staffId: row.staffId,
    lastLoginAt: dateToIso(row.lastLoginAt),
    invitation,
    ...auditFields(row),
  };
}
