import { BadRequestException } from '@nestjs/common';

/**
 * Whether a disbursement has to name who was paid, and the refusal when it
 * does not.
 *
 * STATED ONCE FOR BOTH CALLERS — a liquidation line and a company-paid expense
 * ask the identical question of the identical column, and this codebase's
 * recurring defect is a guard copied to a second site and then only half
 * updated. `assertMayHoldTripCash` exists for the same reason.
 *
 * The rule lives on `ExpenseCategory.requiresPayee` and is RESOLVED HERE, not
 * in Zod: its input is another table, which a request schema cannot see. The
 * value returned is then frozen onto the row, and a CHECK constraint pairs the
 * frozen flag with the payee — so the database refuses the same rows this does,
 * rather than trusting the service to have been called.
 *
 * Note this doubles as the category's existence check. Splitting them would
 * mean two reads of the same row and two chances to forget one.
 */

/** The slice of `expense_category` this needs. */
interface CategoryLookup {
  findFirst(args: {
    where: { id: string };
    select: { name: true; requiresPayee: true };
  }): Promise<{ name: string; requiresPayee: boolean } | null>;
}

export async function resolvePayeeRequirement(
  categories: CategoryLookup,
  expenseCategoryId: string,
  payeeId: string | null,
): Promise<boolean> {
  const category = await categories.findFirst({
    where: { id: expenseCategoryId },
    select: { name: true, requiresPayee: true },
  });

  if (!category) {
    throw badRequest('expenseCategoryId', `No expense category with id ${expenseCategoryId}`);
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

  return category.requiresPayee;
}

function badRequest(path: string, message: string): BadRequestException {
  return new BadRequestException({ message: 'Validation failed', errors: [{ path, message }] });
}
