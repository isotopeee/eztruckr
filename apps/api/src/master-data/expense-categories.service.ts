import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  CreateExpenseCategoryInput,
  ExpenseCategory,
  ExpenseCategoryListQuery,
  Page,
  RemovalResult,
  UpdateExpenseCategoryInput,
} from '@eztruckr/types';
import { PrismaService } from '../prisma/prisma.service';
import { removeRecord } from './removal';
import { auditFields } from './serialize';

type ExpenseCategoryRow = Prisma.ExpenseCategoryGetPayload<Record<string, never>>;

/**
 * Expense categories are the one master data table where a real delete is
 * allowed.
 *
 * They are classification, not history: a category nobody ever filed anything
 * under records nothing, and leaving mistyped ones soft-deleted forever just
 * accumulates clutter in a table whose whole job is to be a short, legible
 * list. The moment one has been used, that argument disappears — the category
 * is now part of what a liquidation line says — and it deactivates instead.
 */
@Injectable()
export class ExpenseCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  private get categories() {
    return this.prisma.client.expenseCategory;
  }

  /**
   * `offeredFor` is what keeps each picker to its own side of the house.
   *
   * Without it every form fetched this list unfiltered, so the first overhead
   * category anybody created — "Office rent", "SSS contributions" — appeared in
   * a crew member's liquidation dropdown on the road, beside Fuel and Toll.
   *
   * OMITTING IT MEANS EVERY CATEGORY, which is what the management screen
   * wants: it is the one caller that EDITS the flags, so it has to be able to
   * see a category that is currently offered nowhere it can reach.
   */
  async list(query: ExpenseCategoryListQuery): Promise<Page<ExpenseCategory>> {
    const where: Prisma.ExpenseCategoryWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
      ...(query.offeredFor === 'trips' ? { offeredOnTrips: true } : {}),
      ...(query.offeredFor === 'overhead' ? { offeredOnOverhead: true } : {}),
      ...(query.search
        ? {
            OR: [{ name: { contains: query.search, mode: 'insensitive' } }],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.categories.findMany({
        where,
        // sortOrder is what the liquidation form renders in; name only breaks
        // ties so the list is stable when two categories share a position.
        orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.categories.count({ where }),
    ]);

    return {
      items: rows.map(toExpenseCategory),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<ExpenseCategory> {
    const row = await this.categories.findFirst({ where: { id } });

    if (!row) {
      throw new NotFoundException(`No expense category with id ${id}`);
    }

    return toExpenseCategory(row);
  }

  async create(input: CreateExpenseCategoryInput): Promise<ExpenseCategory> {
    return toExpenseCategory(await this.categories.create({ data: { ...input } }));
  }

  async update(id: string, input: UpdateExpenseCategoryInput): Promise<ExpenseCategory> {
    await this.get(id);
    return toExpenseCategory(await this.categories.update({ where: { id }, data: input }));
  }

  /**
   * Unused: really deleted. Used: deactivated.
   *
   * ALL FOUR TABLES THAT CLASSIFY AGAINST A CATEGORY ARE PROBED, and the list
   * has to stay complete. Every one of those foreign keys is ON DELETE
   * RESTRICT, so a category referenced only by a table missing from here
   * reaches the database as a delete and fails there — a 409 the user cannot
   * act on, instead of the deactivation they wanted. `company_paid_expense` was
   * missing from this list and is the reason it is now spelled out;
   * `operation_expense` is the newest, and is the only one of the four that
   * hangs off no shipment.
   */
  async remove(id: string): Promise<RemovalResult> {
    await this.get(id);

    return removeRecord({
      probes: [
        {
          entity: 'liquidation lines',
          count: () =>
            this.prisma.client.liquidationLine.count({ where: { expenseCategoryId: id } }),
        },
        {
          entity: 'billable expenses',
          count: () =>
            this.prisma.client.billableExpense.count({ where: { expenseCategoryId: id } }),
        },
        {
          entity: 'company-paid expenses',
          count: () =>
            this.prisma.client.companyPaidExpense.count({ where: { expenseCategoryId: id } }),
        },
        {
          entity: 'operation expenses',
          count: () =>
            this.prisma.client.operationExpense.count({ where: { expenseCategoryId: id } }),
        },
      ],
      deactivate: () => this.categories.update({ where: { id }, data: { isActive: false } }),
      softDelete: () => this.categories.softDelete({ id }),
      hardDelete: () => this.categories.delete({ where: { id } }),
    });
  }
}

function toExpenseCategory(row: ExpenseCategoryRow): ExpenseCategory {
  return {
    id: row.id,
    name: row.name,
    requiresReceipt: row.requiresReceipt,
    requiresPayee: row.requiresPayee,
    defaultCommissionable: row.defaultCommissionable,
    offeredOnTrips: row.offeredOnTrips,
    offeredOnOverhead: row.offeredOnOverhead,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    ...auditFields(row),
  };
}
