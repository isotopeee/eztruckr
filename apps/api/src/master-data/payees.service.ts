import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  CreatePayeeInput,
  MasterDataListQuery,
  Page,
  Payee,
  PayeeType,
  RemovalResult,
  UpdatePayeeInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields } from './serialize';

type PayeeRow = Prisma.PayeeGetPayload<Record<string, never>>;

@Injectable()
export class PayeesService {
  constructor(private readonly prisma: PrismaService) {}

  private get payees() {
    return this.prisma.client.payee;
  }

  async list(query: MasterDataListQuery): Promise<Page<Payee>> {
    const where: Prisma.PayeeWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { contactName: { contains: query.search, mode: 'insensitive' } },
              // Searchable because reconciling a supplier statement starts
              // from the TIN on it as often as from the trading name.
              { tin: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.payees.findMany({
        where,
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.payees.count({ where }),
    ]);

    return { items: rows.map(toPayee), total, page: query.page, pageSize: query.pageSize };
  }

  async get(id: string): Promise<Payee> {
    const row = await this.payees.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No payee with id ${id}`);
    }

    return toPayee(row);
  }

  async create(input: CreatePayeeInput): Promise<Payee> {
    return toPayee(await this.payees.create({ data: { ...input } }));
  }

  async update(id: string, input: UpdatePayeeInput): Promise<Payee> {
    await this.get(id);
    return toPayee(await this.payees.update({ where: { id }, data: input }));
  }

  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    // Both cost rows that can name a payee. Missing either would let a vendor
    // be soft-deleted out from under a liquidation somebody still has to
    // approve — the ON DELETE RESTRICT foreign keys would catch a hard delete,
    // but nothing would catch the soft one.
    return removeRecord({
      probes: [
        {
          entity: 'liquidation lines',
          count: () => this.prisma.client.liquidationLine.count({ where: { payeeId: id } }),
        },
        {
          entity: 'company-paid expenses',
          count: () => this.prisma.client.companyPaidExpense.count({ where: { payeeId: id } }),
        },
      ],
      deactivate: () => this.payees.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.payees.softDelete({ id }),
    });
  }
}

function toPayee(row: PayeeRow): Payee {
  return {
    id: row.id,
    // SMALLINT widens to `number` in the generated client; the CHECK
    // constraint and the Zod schema on the way in are what make it a code.
    payeeType: row.payeeType as PayeeType,
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
