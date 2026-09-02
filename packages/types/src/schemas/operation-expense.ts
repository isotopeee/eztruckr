import { z } from 'zod';
import {
  auditFieldsSchema,
  idSchema,
  isoDateTimeSchema,
  optionalText,
  paginationQuerySchema,
} from './common';
import { positiveMoneyStringSchema } from './shipment';

/**
 * A running cost of the BUSINESS, belonging to no trip.
 *
 * Office rent, electricity, the accountant's retainer, comprehensive insurance,
 * an LTO registration renewal, a workshop invoice for a truck sitting idle
 * between jobs. Real money leaving the company that no shipment caused and none
 * should be charged for.
 *
 * WHY THIS IS ITS OWN RECORD, and not a company-paid expense with the shipment
 * left off. Every money line the system already has answers a question about
 * ONE TRIP:
 *
 *   LiquidationLine    — the crew spent it out of that trip's cash.
 *   CompanyPaidExpense — the company paid it, for that trip, directly.
 *   BillableExpense    — the company fronted it and rebills that trip's client.
 *   AdditionalCharge   — a fee on that trip with no underlying cost.
 *
 * Overhead fits none of them, and the tempting fix — making
 * `CompanyPaidExpense.shipmentId` nullable — is the one to refuse. That column
 * is what every per-trip cost read joins on, so a nullable version would make a
 * trip's margin depend on a WHERE clause rather than on which table a row is
 * in. See the model docblock in `schema.prisma` for the rest of it.
 *
 * NOT A COST OF ANY TRIP, which is what makes it absent from `GrossProfit`.
 * Overhead is by definition not attributable to one shipment, and apportioning
 * it across trips would invent a number — the one thing the money path never
 * does. `grossProfitSchema` names the deliberate absences beside it; this joins
 * that list.
 *
 * RECOGNISED WHEN RECORDED, exactly as a company-paid expense is: the money
 * left before anybody typed the row, so there is no lifecycle to wait for and a
 * status column would only pretend otherwise.
 */
export const operationExpenseSchema = auditFieldsSchema.extend({
  id: z.string(),
  expenseCategoryId: z.string(),
  expenseCategoryName: z.string().nullable(),
  description: z.string().nullable(),
  amount: z.string(),
  spentAt: z.string(),
  payeeId: z.string().nullable(),
  payeeName: z.string().nullable(),
  /** The rule that applied to THIS row, frozen when it was written. */
  payeeRequired: z.boolean(),
  referenceNumber: z.string().nullable(),
  receiptId: z.string().nullable(),
  receiptFileName: z.string().nullable(),
  /** Who keyed it in. The ledger is read by people who did not type it. */
  recordedByName: z.string().nullable(),
});

export type OperationExpense = z.infer<typeof operationExpenseSchema>;

export const createOperationExpenseSchema = z.object({
  /**
   * Required, and the SAME category list the trip-level costs use. This row
   * exists to be a cost in the company's P&L, and an uncategorised cost is one
   * nobody can report on — the identical argument
   * `createCompanyPaidExpenseSchema` makes.
   */
  expenseCategoryId: idSchema,
  description: optionalText(200),
  amount: positiveMoneyStringSchema,
  /** When the money actually left, which is not when somebody typed it in. */
  spentAt: isoDateTimeSchema,
  /**
   * Who the company paid. Optional here, required by the expense category —
   * see the note on `createLiquidationLineSchema.payeeId`.
   */
  payeeId: idSchema.nullish().transform((value) => value ?? null),
  /**
   * Invoice, official receipt or transaction reference. Optional, like every
   * other reference in the system: a mandatory one is answered with an invented
   * one, which reads like evidence and is not.
   */
  referenceNumber: optionalText(80),
  receiptId: idSchema.nullish().transform((value) => value ?? null),
});

export type CreateOperationExpenseInput = z.infer<typeof createOperationExpenseSchema>;

export const updateOperationExpenseSchema = createOperationExpenseSchema.partial();

export type UpdateOperationExpenseInput = z.infer<typeof updateOperationExpenseSchema>;

/**
 * The ledger, read as a period.
 *
 * THE DATE WINDOW IS THE PRIMARY FILTER HERE, where every other list in the
 * system takes an entity id first. There is no trip and no client to narrow by:
 * the question this table answers is "what did running the business cost in
 * August", so `from` and `to` are what the screen is actually built around and
 * the category is the secondary cut.
 *
 * Both bounds are optional, and the window is INCLUSIVE OF `from`, EXCLUSIVE OF
 * `to` — a half-open interval, so consecutive months tile without the boundary
 * appearing in both. A closed upper bound is the classic way an expense dated
 * midday on the 31st vanishes from every report.
 */
export const operationExpenseListQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().max(120).optional(),
  expenseCategoryId: idSchema.optional(),
  payeeId: idSchema.optional(),
  /** Inclusive lower bound on `spentAt`. */
  from: isoDateTimeSchema.optional(),
  /** EXCLUSIVE upper bound on `spentAt`. See the note above. */
  to: isoDateTimeSchema.optional(),
});

export type OperationExpenseListQuery = z.infer<typeof operationExpenseListQuerySchema>;

/**
 * The window a summary was computed over, on its own.
 *
 * The list query's filters minus its pagination: a total is over a period and a
 * category, never over "page 2". Derived from the list schema rather than
 * declared again so the two cannot narrow differently — a summary that answered
 * for a wider set of rows than the list beneath it is the defect worth
 * preventing here.
 */
export const operationExpenseSummaryQuerySchema = operationExpenseListQuerySchema.omit({
  page: true,
  pageSize: true,
});

export type OperationExpenseSummaryQuery = z.infer<typeof operationExpenseSummaryQuerySchema>;

/** One category's share of a period's overhead. */
export const operationExpenseCategoryTotalSchema = z.object({
  expenseCategoryId: z.string(),
  expenseCategoryName: z.string().nullable(),
  amount: z.string(),
  count: z.number().int().nonnegative(),
});

export type OperationExpenseCategoryTotal = z.infer<typeof operationExpenseCategoryTotalSchema>;

/**
 * What the period cost, and on what.
 *
 * THE BREAKDOWN TRAVELS WITH THE TOTAL, the same decision `GrossProfit` and
 * `ClientPaymentSummary` both make. A single overhead figure is a number nobody
 * can act on: "₱412,000 last month" prompts exactly one question, and the
 * answer should not need a second request against a different filter.
 *
 * THE WINDOW IS ECHOED BACK because both bounds are optional. A total with no
 * stated period means something different depending on what the caller happened
 * to send, and a screenshot of one is unreadable a week later.
 */
export const operationExpenseSummarySchema = z.object({
  from: z.string().nullable(),
  to: z.string().nullable(),
  total: z.string(),
  count: z.number().int().nonnegative(),
  byCategory: z.array(operationExpenseCategoryTotalSchema),
});

export type OperationExpenseSummary = z.infer<typeof operationExpenseSummarySchema>;
