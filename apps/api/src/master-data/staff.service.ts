import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  isStaffRole,
  LICENCE_REQUIRED_MESSAGES,
  missingLicenceField,
  type CreateStaffInput,
  type Staff,
  type StaffRole,
  type MasterDataListQuery,
  type Page,
  type RemovalResult,
  type UpdateStaffInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields, dateToIso } from './serialize';

type StaffRow = Prisma.StaffGetPayload<Record<string, never>>;

@Injectable()
export class StaffService {
  constructor(private readonly prisma: PrismaService) {}

  private get staff() {
    return this.prisma.client.staff;
  }

  async list(query: MasterDataListQuery): Promise<Page<Staff>> {
    const where: Prisma.StaffWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.staff.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { lastName: 'asc' }, { firstName: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.staff.count({ where }),
    ]);

    return { items: rows.map(toStaff), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<Staff> {
    const row = await this.staff.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No staff member with id ${id}`);
    }

    return toStaff(row);
  }

  async create(input: CreateStaffInput): Promise<Staff> {
    const row = await this.staff.create({
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email: input.email,
        address: input.address,
        dateHired: input.dateHired,
        eligibleRoles: [...input.eligibleRoles],
        licenseNumber: input.licenseNumber,
        licenseExpiry: input.licenseExpiry,
        isActive: input.isActive,
      },
    });

    return toStaff(row);
  }

  /**
   * The driver/licence rule is checked here rather than in the schema, because
   * a PATCH carrying only `eligibleRoles` has no licence to check against and
   * one carrying only `licenseNumber` has no roles. Merging the patch onto the
   * stored row first is the only way to ask the question honestly — otherwise
   * adding DRIVER eligibility to an existing helper would slip through with no
   * licence on file.
   *
   * BOTH HALVES are required of a driver now, number and expiry. The merge has
   * to carry the expiry for the same reason it carries the number: a PATCH that
   * only adds DRIVER eligibility must be judged against what is already stored.
   */
  async update(id: string, input: UpdateStaffInput): Promise<Staff> {
    const current = await this.get(id);

    const merged = {
      eligibleRoles: input.eligibleRoles ?? current.eligibleRoles,
      licenseNumber:
        input.licenseNumber === undefined ? current.licenseNumber : input.licenseNumber,
      licenseExpiry:
        input.licenseExpiry === undefined ? current.licenseExpiry : input.licenseExpiry,
    };

    const missing = missingLicenceField(merged);

    if (missing) {
      throw new BadRequestException({
        message: 'Validation failed',
        // Named field, not always `licenseNumber`: a record with a number and
        // no expiry has to point at the expiry, or the office looks at a value
        // that was already right.
        errors: [{ path: missing, message: LICENCE_REQUIRED_MESSAGES[missing] }],
      });
    }

    const row = await this.staff.update({
      where: { id },
      data: {
        ...input,
        ...(input.eligibleRoles ? { eligibleRoles: [...input.eligibleRoles] } : {}),
      },
    });

    return toStaff(row);
  }

  /**
   * A staff member who has driven, been paid or owed anything is permanently
   * part of that record. In practice almost every removal here lands on
   * DEACTIVATED, which is the correct state for someone who has left.
   */
  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    const client = this.prisma.client;

    return removeRecord({
      probes: [
        {
          entity: 'shipments',
          count: () =>
            client.shipment.count({ where: { OR: [{ driverId: id }, { helperId: id }] } }),
        },
        {
          entity: 'commissions',
          count: () => client.commission.count({ where: { staffId: id } }),
        },
        {
          entity: 'allowances',
          count: () => client.allowance.count({ where: { staffId: id } }),
        },
        {
          entity: 'deductions',
          count: () => client.crewDeduction.count({ where: { staffId: id } }),
        },
        {
          entity: 'adjustments',
          count: () => client.adjustment.count({ where: { staffId: id } }),
        },
        {
          entity: 'payout lines',
          count: () => client.payoutLine.count({ where: { staffId: id } }),
        },
        {
          // Trips whose cash this person is answerable for. Missing until now:
          // the column arrived with per-custodian liquidations and this list is
          // enumerated by hand, one probe per relation. A soft delete does not
          // fire the ON DELETE RESTRICT foreign key, so without this probe the
          // person simply vanished from a liquidation that still named them.
          entity: 'liquidations held',
          count: () => client.liquidation.count({ where: { custodianId: id } }),
        },
        {
          entity: 'portal logins',
          count: () => client.user.count({ where: { staffId: id } }),
        },
      ],
      deactivate: () => this.staff.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.staff.softDelete({ id }),
    });
  }
}

function toStaff(row: StaffRow): Staff {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    dateHired: dateToIso(row.dateHired),
    isActive: row.isActive,
    // The column is SMALLINT[]; a value outside the code set means the array
    // CHECK constraint was bypassed, so drop it rather than hand the UI a code
    // it has no label for.
    eligibleRoles: row.eligibleRoles.filter((role): role is StaffRole => isStaffRole(role)),
    licenseNumber: row.licenseNumber,
    licenseExpiry: dateToIso(row.licenseExpiry),
    ...auditFields(row),
  };
}
