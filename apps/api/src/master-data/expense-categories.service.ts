import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import type {
  CreateExpenseCategoryInput,
  ExpenseCategory,
  MasterDataListQuery,
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

  async list(query: MasterDataListQuery): Promise<Page<ExpenseCategory>> {
    const where: Prisma.ExpenseCategoryWhereInput = {
      ...(query.includeInactive ? {} : { isActive: true }),
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
   * Billable expenses are probed alongside liquidation lines. Both foreign
   * keys are ON DELETE RESTRICT, so a category referenced only by a billable
   * expense would otherwise reach the database as a delete and fail there —
   * a 409 the user cannot act on, instead of the deactivation they wanted.
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
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    ...auditFields(row),
  };
}
