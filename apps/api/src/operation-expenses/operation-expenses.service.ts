import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@eztruckr/db';
import {
  sum,
  toDecimalString,
  type CreateOperationExpenseInput,
  type OperationExpense,
  type OperationExpenseCategoryTotal,
  type OperationExpenseListQuery,
  type OperationExpenseSummary,
  type OperationExpenseSummaryQuery,
  type Page,
  type UpdateOperationExpenseInput,
} from '@eztruckr/types';
import { resolveExpenseCategoryRules } from '../master-data/expense-category-rules';
import { auditFields } from '../master-data/serialize';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What it costs to keep the company open, as opposed to what a trip costs.
 *
 * NO SHIPMENT ANYWHERE IN THIS SERVICE, and that absence is most of the design.
 * `CompanyPaidExpensesService` — the nearest neighbour, and nearly the same
 * shape — begins every method by loading a shipment: to scope the read, to
 * check the trip is still open, and to prove the row being edited belongs to
 * the trip in the path. None of those three has an analogue here. There is no
 * trip to scope to, no CLOSED to refuse against, and no second entity a row
 * could belong to, so an id is either ours or does not exist.
 *
 * WHICH LEAVES NO LOCK AT ALL, and that is deliberate rather than unfinished.
 * A trip's costs freeze when the trip closes; this has no trip, and the system
 * has no accounting period to close instead. Inventing one here — "the month is
 * shut on the 5th" — would be a rule with no event behind it and nothing to
 * point at when somebody asked who shut it. Correcting last quarter's rent
 * stays possible, and the soft delete records who did it.
 *
 * WHAT IS SHARED WITH THE TRIP-LEVEL EXPENSES is the part that must not drift:
 * the payee rule comes from `resolveExpenseCategoryRules`, against the same
 * `expense_category` table, and is frozen onto the row the same way. A second
 * copy of that rule is precisely the defect this codebase keeps finding.
 */
@Injectable()
export class OperationExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  private get expenses() {
    return this.prisma.client.operationExpense;
  }

  async list(query: OperationExpenseListQuery): Promise<Page<OperationExpense>> {
    const where = this.filter(query);

    const [rows, total] = await Promise.all([
      this.expenses.findMany({
        where,
        include: EXPENSE_INCLUDE,
        // Most recent first: the ledger is opened to see what has just been
        // recorded, not to read the company's history from the beginning.
        // `createdAt` breaks ties so a page boundary is stable when a month's
        // worth of invoices are all dated the first.
        orderBy: [{ spentAt: 'desc' }, { createdAt: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.expenses.count({ where }),
    ]);

    return {
      items: rows.map(toOperationExpense),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(id: string): Promise<OperationExpense> {
    return toOperationExpense(await this.load(id));
  }

  /**
   * What the period cost, and on what.
   *
   * COMPUTED OVER THE SAME `where` AS THE LIST, from the same helper, so the
   * total above a table always describes the rows in it. Two filter builders
   * would eventually narrow differently — the classic version of this bug is a
   * summary that ignores the category filter and reports the whole month —
   * and it is the kind that reads as plausible for a long time.
   *
   * SUMMED IN JAVASCRIPT VIA `sum()`, not by a Postgres `SUM`. The money helper
   * is what every other total in the system goes through, and a DECIMAL
   * aggregate arrives as a `Prisma.Decimal` that then has to be converted by
   * hand at the same 4dp — two roundings instead of one, in a place nobody
   * would look. The page is bounded by the period, not by `pageSize`, so the
   * row count this reads is a month of invoices rather than a table scan.
   */
  async summarise(query: OperationExpenseSummaryQuery): Promise<OperationExpenseSummary> {
    const rows = await this.expenses.findMany({
      where: this.filter(query),
      select: {
        amount: true,
        expenseCategoryId: true,
        expenseCategory: { select: { name: true } },
      },
    });

    const byCategory = new Map<string, { name: string | null; amounts: string[] }>();

    for (const row of rows) {
      const bucket = byCategory.get(row.expenseCategoryId) ?? {
        name: row.expenseCategory?.name ?? null,
        amounts: [],
      };
      bucket.amounts.push(row.amount.toString());
      byCategory.set(row.expenseCategoryId, bucket);
    }

    const totals: OperationExpenseCategoryTotal[] = [...byCategory.entries()]
      .map(([expenseCategoryId, bucket]) => ({
        expenseCategoryId,
        expenseCategoryName: bucket.name,
        amount: toDecimalString(sum(bucket.amounts)),
        count: bucket.amounts.length,
      }))
      // Largest first: the point of a breakdown is which line to look at.
      .sort((a, b) => Number(b.amount) - Number(a.amount));

    return {
      from: query.from ?? null,
      to: query.to ?? null,
      total: toDecimalString(sum(rows.map((row) => row.amount))),
      count: rows.length,
      byCategory: totals,
    };
  }

  async add(input: CreateOperationExpenseInput): Promise<OperationExpense> {
    await this.assertPayeeExists(input.payeeId);
    await this.assertReceiptExists(input.receiptId);

    // Also the category's existence check — see `resolveExpenseCategoryRules`.
    const { payeeRequired } = await resolveExpenseCategoryRules(
      this.prisma.client.expenseCategory,
      input.expenseCategoryId,
      input.payeeId,
      'overhead',
    );

    const row = await this.expenses.create({
      data: {
        expenseCategoryId: input.expenseCategoryId,
        description: input.description,
        amount: input.amount,
        spentAt: new Date(input.spentAt),
        payeeId: input.payeeId,
        payeeRequired,
        referenceNumber: input.referenceNumber,
        receiptId: input.receiptId,
      },
      include: EXPENSE_INCLUDE,
    });

    return toOperationExpense(row);
  }

  async update(id: string, input: UpdateOperationExpenseInput): Promise<OperationExpense> {
    await this.load(id);
    await this.assertPayeeExists(input.payeeId);
    await this.assertReceiptExists(input.receiptId);

    // Both halves of the rule are re-resolved against what the row will look
    // like AFTER the patch, not what was sent. A PATCH that changes only the
    // category can make a previously legal row illegal, and one that only
    // clears the payee is the same failure from the other side; validating the
    // request alone would miss both.
    const payeeRequired = await this.resolveRequirementAfterPatch(id, input);

    const row = await this.expenses.update({
      where: { id },
      data: {
        ...(input.expenseCategoryId === undefined
          ? {}
          : { expenseCategoryId: input.expenseCategoryId }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.amount === undefined ? {} : { amount: input.amount }),
        ...(input.spentAt === undefined ? {} : { spentAt: new Date(input.spentAt) }),
        ...(input.payeeId === undefined ? {} : { payeeId: input.payeeId }),
        ...(input.referenceNumber === undefined ? {} : { referenceNumber: input.referenceNumber }),
        ...(input.receiptId === undefined ? {} : { receiptId: input.receiptId }),
        // Re-stamped: the row's frozen rule follows its category.
        payeeRequired,
      },
      include: EXPENSE_INCLUDE,
    });

    return toOperationExpense(row);
  }

  async remove(id: string): Promise<{ removed: true }> {
    await this.load(id);

    // A soft delete, never a negative row. A supplier credit note and an
    // invoice entered twice are both "this did not happen", and the deletion
    // already records who said so and when — the same call `client_payment`
    // makes, and the reason neither table carries a sign.
    await this.expenses.softDelete({ id });

    return { removed: true };
  }

  // -------------------------------------------------------------------------

  /**
   * The one filter builder, shared by the list and the summary.
   *
   * THE UPPER BOUND IS EXCLUSIVE (`lt`, not `lte`) and the lower is inclusive.
   * Consecutive periods then tile exactly: August's `to` is September's `from`,
   * and no expense is counted in both. The alternative — a closed bound on a
   * timestamp — silently drops anything dated after midnight on the last day,
   * which on a `TIMESTAMPTZ` column is almost everything recorded that day.
   */
  private filter(query: OperationExpenseSummaryQuery): Prisma.OperationExpenseWhereInput {
    return {
      ...(query.expenseCategoryId ? { expenseCategoryId: query.expenseCategoryId } : {}),
      ...(query.payeeId ? { payeeId: query.payeeId } : {}),
      ...(query.from || query.to
        ? {
            spentAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { description: { contains: query.search, mode: 'insensitive' } },
              { referenceNumber: { contains: query.search, mode: 'insensitive' } },
              { payee: { name: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
  }

  private async load(id: string): Promise<ExpenseRow> {
    const row = await this.expenses.findFirst({ where: { id }, include: EXPENSE_INCLUDE });

    if (!row) {
      throw new NotFoundException(`No operation expense with id ${id}`);
    }

    return row;
  }

  /**
   * The category rule applied to the row as the patch will leave it.
   *
   * `undefined` means "this PATCH did not mention the field", so the current
   * value stands; an explicit `null` payee means "clear it", which the rule may
   * refuse.
   */
  private async resolveRequirementAfterPatch(
    id: string,
    input: UpdateOperationExpenseInput,
  ): Promise<boolean> {
    const current = await this.expenses.findFirst({
      where: { id },
      select: { expenseCategoryId: true, payeeId: true },
    });

    if (!current) {
      throw new NotFoundException(`No operation expense with id ${id}`);
    }

    const { payeeRequired } = await resolveExpenseCategoryRules(
      this.prisma.client.expenseCategory,
      input.expenseCategoryId ?? current.expenseCategoryId,
      input.payeeId === undefined ? current.payeeId : input.payeeId,
      'overhead',
    );

    return payeeRequired;
  }

  /**
   * Existence only, deliberately — not `isActive`, matching every other
   * reference check in the system. A deactivated payee is one no longer OFFERED
   * for new work, and refusing it here would block correcting an expense whose
   * supplier has since been retired.
   *
   * Whether absence is ALLOWED is `resolveExpenseCategoryRules`'s question, asked
   * against the expense category — checking it here as well would put half the
   * rule in two places.
   */
  private async assertPayeeExists(payeeId: string | null | undefined): Promise<void> {
    if (!payeeId) return;

    const found = await this.prisma.client.payee.findFirst({
      where: { id: payeeId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest('payeeId', `No payee with id ${payeeId}`);
    }
  }

  private async assertReceiptExists(receiptId: string | null | undefined): Promise<void> {
    if (!receiptId) return;

    const found = await this.prisma.client.receipt.findFirst({
      where: { id: receiptId },
      select: { id: true },
    });

    if (!found) {
      throw badRequest('receiptId', `No receipt with id ${receiptId}`);
    }
  }
}

const EXPENSE_INCLUDE = {
  expenseCategory: { select: { name: true } },
  payee: { select: { name: true } },
  receipt: { select: { fileName: true } },
  createdByUser: { select: { name: true } },
} satisfies Prisma.OperationExpenseInclude;

type ExpenseRow = Prisma.OperationExpenseGetPayload<{ include: typeof EXPENSE_INCLUDE }>;

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}

function toOperationExpense(row: ExpenseRow): OperationExpense {
  return {
    id: row.id,
    expenseCategoryId: row.expenseCategoryId,
    expenseCategoryName: row.expenseCategory?.name ?? null,
    description: row.description,
    amount: row.amount.toString(),
    spentAt: row.spentAt.toISOString(),
    payeeId: row.payeeId,
    payeeName: row.payee?.name ?? null,
    payeeRequired: row.payeeRequired,
    referenceNumber: row.referenceNumber,
    receiptId: row.receiptId,
    receiptFileName: row.receipt?.fileName ?? null,
    recordedByName: row.createdByUser?.name ?? null,
    ...auditFields(row),
  };
}
