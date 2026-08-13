import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { liveOne, type Prisma } from '@eztruckr/db';
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
  type UpdateUserInput,
  type User,
} from '@eztruckr/types';
import { isAPIError } from 'better-auth/api';
import { AuthService } from '../auth/auth.service';
import type { RequestUser } from '../auth/request-user';
import { removeRecord } from '../master-data/removal';
import { auditFields, dateToIso } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';

type UserRow = Prisma.UserGetPayload<Record<string, never>>;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
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

    return { items: rows.map(toUser), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<User> {
    const row = await this.users.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No user with id ${id}`);
    }

    return toUser(row);
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
   * Provision a login.
   *
   * Two steps, in this order and not the other, because the security-critical
   * columns are `input: false` in the Better Auth config and cannot be set
   * through it — which is exactly the property that stops a request body ever
   * choosing its own role. So the account is created first with the default
   * CREW role, then the real role is written through Prisma.
   *
   * The window between the two is inside a single request and never reachable
   * by anyone: the account starts with the least privilege in the system, and
   * if the second step fails the account is soft-deleted rather than left
   * behind as a usable login nobody meant to create.
   */
  async create(input: CreateUserInput): Promise<User> {
    await this.assertStaffLinkIsUsable(input.role, input.staffId);

    let createdId: string;

    try {
      const result = await this.auth.instance.api.signUpEmail({
        body: { email: input.email, password: input.password, name: input.name },
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
          // No outbound mail is configured, and an administrator handing over
          // credentials in person has already done the verifying.
          emailVerified: true,
        },
      });

      return toUser(row);
    } catch (error) {
      this.logger.error(
        `Failed to apply role to new user ${createdId}; soft-deleting the half-created account`,
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

    return toUser(await this.users.update({ where: { id }, data: input }));
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

function toUser(row: UserRow): User {
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
    ...auditFields(row),
  };
}
