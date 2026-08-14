import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  CreateThirdPartyInput,
  MasterDataListQuery,
  Page,
  RemovalResult,
  ThirdParty,
  UpdateThirdPartyInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields, decimalToString } from './serialize';

type ThirdPartyRow = Prisma.ThirdPartyGetPayload<Record<string, never>>;

@Injectable()
export class ThirdPartiesService {
  constructor(private readonly prisma: PrismaService) {}

  private get thirdParties() {
    return this.prisma.client.thirdParty;
  }

  async list(query: MasterDataListQuery): Promise<Page<ThirdParty>> {
    const where: Prisma.ThirdPartyWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { contactName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.thirdParties.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.thirdParties.count({ where }),
    ]);

    return { items: rows.map(toThirdParty), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<ThirdParty> {
    const row = await this.thirdParties.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No third party with id ${id}`);
    }

    return toThirdParty(row);
  }

  async create(input: CreateThirdPartyInput): Promise<ThirdParty> {
    return toThirdParty(await this.thirdParties.create({ data: { ...input } }));
  }

  async update(id: string, input: UpdateThirdPartyInput): Promise<ThirdParty> {
    await this.get(id);
    return toThirdParty(await this.thirdParties.update({ where: { id }, data: input }));
  }

  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    return removeRecord({
      probes: [
        {
          entity: 'shipments',
          count: () => this.prisma.client.shipment.count({ where: { thirdPartyId: id } }),
        },
      ],
      deactivate: () => this.thirdParties.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.thirdParties.softDelete({ id }),
    });
  }
}

function toThirdParty(row: ThirdPartyRow): ThirdParty {
  return {
    id: row.id,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    defaultCommissionRate: decimalToString(row.defaultCommissionRate),
    isActive: row.isActive,
    ...auditFields(row),
  };
}
