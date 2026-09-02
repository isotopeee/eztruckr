import { BadRequestException } from '@nestjs/common';
import type { ExpenseCategoryUse } from '@eztruckr/types';

/**
 * Everything an expense category decides about the row being written, and the
 * refusals when it says no.
 *
 * STATED ONCE FOR ALL FOUR CALLERS — a liquidation line, a billable expense, a
 * company-paid expense and an operation expense all ask the identical questions
 * of the identical row, and this codebase's recurring defect is a guard copied
 * to a second site and then only half updated. `assertMayHoldTripCash` exists
 * for the same reason.
 *
 * TWO RULES AND ONE READ, which is why they live in one function rather than
 * two beside each other. The alternative is two `findFirst`s of the same row
 * and two chances to forget one; the existence check makes a third, and it also
 * comes free here. This file was `payee-requirement.ts` while there was only
 * one rule, and was renamed rather than grown quietly under a name that had
 * stopped being true.
 *
 * WHERE EACH RULE LIVES, AND HOW IT IS BACKED:
 *
 *   `requiresPayee`  — resolved here and COPIED onto the row, then paired with
 *                      the payee by a CHECK on each table, so the database
 *                      refuses the same rows this does rather than trusting the
 *                      service to have been called.
 *   `offeredOn…`     — resolved here and NOT copied anywhere. It decides what a
 *                      form may OFFER, which is the `isActive` question, so a
 *                      category relaxed later leaves past rows reading
 *                      correctly. No CHECK can back it: it is a rule about two
 *                      tables, and freezing it would make it say something it
 *                      does not mean.
 */

/** The slice of `expense_category` this needs. */
interface CategoryLookup {
  findFirst(args: {
    where: { id: string };
    select: {
      name: true;
      requiresPayee: true;
      offeredOnTrips: true;
      offeredOnOverhead: true;
    };
  }): Promise<{
    name: string;
    requiresPayee: boolean;
    offeredOnTrips: boolean;
    offeredOnOverhead: boolean;
  } | null>;
}

export interface ExpenseCategoryRules {
  /** Frozen onto the row by every caller. */
  payeeRequired: boolean;
}

export async function resolveExpenseCategoryRules(
  categories: CategoryLookup,
  expenseCategoryId: string,
  payeeId: string | null,
  /** Which ledger is asking. Trip-side callers pass `'trips'`. */
  offeredFor: ExpenseCategoryUse,
): Promise<ExpenseCategoryRules> {
  const category = await categories.findFirst({
    where: { id: expenseCategoryId },
    select: {
      name: true,
      requiresPayee: true,
      offeredOnTrips: true,
      offeredOnOverhead: true,
    },
  });

  if (!category) {
    throw badRequest('expenseCategoryId', `No expense category with id ${expenseCategoryId}`);
  }

  const offered = offeredFor === 'trips' ? category.offeredOnTrips : category.offeredOnOverhead;

  if (!offered) {
    // Names the category and BOTH sides, because the person filling the form
    // is looking at a list that should not have contained it — so the useful
    // information is which screen the category does belong on, not that this
    // one refused it.
    throw badRequest(
      'expenseCategoryId',
      offeredFor === 'trips'
        ? `${category.name} is an overhead category and cannot be filed against a trip. Choose a trip category, or offer this one on trips under Expense categories.`
        : `${category.name} is a trip category and cannot be filed as an operation expense. Choose an overhead category, or offer this one on overhead under Expense categories.`,
    );
  }

  if (category.requiresPayee && payeeId === null) {
    // Names the category, because the person filling the form chose it and can
    // act on that — either pick a payee or pick the category that fits. "Payee
    // is required" alone reads as a bug when the previous line needed none.
    throw badRequest(
      'payeeId',
      `${category.name} expenses must record who was paid. Choose a payee, or use a category that does not require one.`,
    );
  }

  return { payeeRequired: category.requiresPayee };
}

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}
