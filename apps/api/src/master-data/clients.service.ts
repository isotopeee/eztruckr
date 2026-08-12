import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  Client,
  CreateClientInput,
  MasterDataListQuery,
  Page,
  RemovalResult,
  UpdateClientInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields } from './serialize';

type ClientRow = Prisma.ClientGetPayload<Record<string, never>>;

@Injectable()
export class ClientsService {
  constructor(private readonly prisma: PrismaService) {}

  private get clients() {
    return this.prisma.client.client;
  }

  async list(query: MasterDataListQuery): Promise<Page<Client>> {
    const where: Prisma.ClientWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: 'insensitive' } },
              { name: { contains: query.search, mode: 'insensitive' } },
              { contactName: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.clients.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.clients.count({ where }),
    ]);

    return { items: rows.map(toClient), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<Client> {
    const row = await this.clients.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No client with id ${id}`);
    }

    return toClient(row);
  }

  async create(input: CreateClientInput): Promise<Client> {
    return toClient(await this.clients.create({ data: { ...input } }));
  }

  async update(id: string, input: UpdateClientInput): Promise<Client> {
    await this.get(id);
    return toClient(await this.clients.update({ where: { id }, data: input }));
  }

  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    return removeRecord({
      probes: [
        {
          entity: 'shipments',
          count: () => this.prisma.client.shipment.count({ where: { clientId: id } }),
        },
        {
          entity: 'commission rules',
          count: () => this.prisma.client.commissionRule.count({ where: { clientId: id } }),
        },
      ],
      deactivate: () => this.clients.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.clients.softDelete({ id }),
    });
  }
}

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactName: row.contactName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    tin: row.tin,
    isActive: row.isActive,
    ...auditFields(row),
  };
}
