import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  hasLicenceIfDriver,
  isCrewRole,
  LICENCE_REQUIRED_MESSAGE,
  type CreateCrewMemberInput,
  type CrewMember,
  type CrewRole,
  type MasterDataListQuery,
  type Page,
  type RemovalResult,
  type UpdateCrewMemberInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields, dateToIso } from './serialize';

type CrewMemberRow = Prisma.CrewMemberGetPayload<Record<string, never>>;

@Injectable()
export class CrewMembersService {
  constructor(private readonly prisma: PrismaService) {}

  private get crew() {
    return this.prisma.client.crewMember;
  }

  async list(query: MasterDataListQuery): Promise<Page<CrewMember>> {
    const where: Prisma.CrewMemberWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { employeeCode: { contains: query.search, mode: 'insensitive' } },
              { firstName: { contains: query.search, mode: 'insensitive' } },
              { lastName: { contains: query.search, mode: 'insensitive' } },
              { phone: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.crew.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { lastName: 'asc' }, { firstName: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.crew.count({ where }),
    ]);

    return { items: rows.map(toCrewMember), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<CrewMember> {
    const row = await this.crew.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No crew member with id ${id}`);
    }

    return toCrewMember(row);
  }

  async create(input: CreateCrewMemberInput): Promise<CrewMember> {
    const row = await this.crew.create({
      data: {
        employeeCode: input.employeeCode,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        address: input.address,
        dateHired: input.dateHired,
        eligibleRoles: [...input.eligibleRoles],
        licenseNumber: input.licenseNumber,
        licenseExpiry: input.licenseExpiry,
        isActive: input.isActive,
      },
    });

    return toCrewMember(row);
  }

  /**
   * The driver/licence rule is checked here rather than in the schema, because
   * a PATCH carrying only `eligibleRoles` has no licence to check against and
   * one carrying only `licenseNumber` has no roles. Merging the patch onto the
   * stored row first is the only way to ask the question honestly — otherwise
   * adding DRIVER eligibility to an existing helper would slip through with no
   * licence on file.
   */
  async update(id: string, input: UpdateCrewMemberInput): Promise<CrewMember> {
    const current = await this.get(id);

    const merged = {
      eligibleRoles: input.eligibleRoles ?? current.eligibleRoles,
      licenseNumber:
        input.licenseNumber === undefined ? current.licenseNumber : input.licenseNumber,
    };

    if (!hasLicenceIfDriver(merged)) {
      throw new BadRequestException({
        message: 'Validation failed',
        errors: [{ path: 'licenseNumber', message: LICENCE_REQUIRED_MESSAGE }],
      });
    }

    const row = await this.crew.update({
      where: { id },
      data: {
        ...input,
        ...(input.eligibleRoles ? { eligibleRoles: [...input.eligibleRoles] } : {}),
      },
    });

    return toCrewMember(row);
  }

  /**
   * A crew member who has driven, been paid or owed anything is permanently
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
          count: () => client.commission.count({ where: { crewMemberId: id } }),
        },
        {
          entity: 'allowances',
          count: () => client.allowance.count({ where: { crewMemberId: id } }),
        },
        {
          entity: 'deductions',
          count: () => client.crewDeduction.count({ where: { crewMemberId: id } }),
        },
        {
          entity: 'adjustments',
          count: () => client.adjustment.count({ where: { crewMemberId: id } }),
        },
        {
          entity: 'payout lines',
          count: () => client.payoutLine.count({ where: { crewMemberId: id } }),
        },
        {
          entity: 'portal logins',
          count: () => client.user.count({ where: { crewMemberId: id } }),
        },
      ],
      deactivate: () => this.crew.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.crew.softDelete({ id }),
    });
  }
}

function toCrewMember(row: CrewMemberRow): CrewMember {
  return {
    id: row.id,
    employeeCode: row.employeeCode,
    firstName: row.firstName,
    lastName: row.lastName,
    phone: row.phone,
    address: row.address,
    dateHired: dateToIso(row.dateHired),
    isActive: row.isActive,
    // The column is SMALLINT[]; a value outside the code set means the array
    // CHECK constraint was bypassed, so drop it rather than hand the UI a code
    // it has no label for.
    eligibleRoles: row.eligibleRoles.filter((role): role is CrewRole => isCrewRole(role)),
    licenseNumber: row.licenseNumber,
    licenseExpiry: dateToIso(row.licenseExpiry),
    ...auditFields(row),
  };
}
