import { describe, expect, it } from 'vitest';
import {
  createExpenseCategorySchema,
  DEFAULT_EXPENSE_CATEGORY_SORT_ORDER,
  expenseCategoryListQuerySchema,
  updateExpenseCategorySchema,
} from './expense-category';

const base = { code: 'DIESEL', name: 'Diesel' };

describe('sortOrder is optional and lands on 10', () => {
  it('defaults when the field is absent', () => {
    expect(createExpenseCategorySchema.parse(base).sortOrder).toBe(
      DEFAULT_EXPENSE_CATEGORY_SORT_ORDER,
    );
  });

  /**
   * THE CASE A PLAIN `.default(10)` WOULD HAVE FAILED. A cleared number input
   * reaches the API as an explicit null, not as an absent field, and
   * `.default()` only fires on undefined — so the form's own "leave it blank"
   * would have come back as a type error about null.
   */
  it('defaults when the form sends an explicit null for a blank input', () => {
    expect(createExpenseCategorySchema.parse({ ...base, sortOrder: null }).sortOrder).toBe(10);
  });

  it('keeps a stated order, including a deliberate zero', () => {
    expect(createExpenseCategorySchema.parse({ ...base, sortOrder: 40 }).sortOrder).toBe(40);
    // 0 is now sayable and means "first", which is what it could never mean
    // while it was also the value for "I didn't say".
    expect(createExpenseCategorySchema.parse({ ...base, sortOrder: 0 }).sortOrder).toBe(0);
  });

  it('still refuses a nonsense order', () => {
    expect(() => createExpenseCategorySchema.parse({ ...base, sortOrder: -1 })).toThrow();
    expect(() => createExpenseCategorySchema.parse({ ...base, sortOrder: 1.5 })).toThrow();
  });
});

/**
 * Where a category is offered.
 *
 * THE ASYMMETRY IS THE TEST. Everything that existed before the overhead ledger
 * is a trip category, so a create that says nothing has to land trip-only —
 * that is what keeps a crew member's liquidation picker showing what it showed
 * yesterday, and what let the migration backfill every existing row with a
 * column default instead of an UPDATE.
 */
describe('a category says where it is offered, and defaults to trips', () => {
  it('lands on trips when the create says nothing', () => {
    const category = createExpenseCategorySchema.parse(base);

    expect(category.offeredOnTrips).toBe(true);
    expect(category.offeredOnOverhead).toBe(false);
  });

  it('lets one category serve both, which is why this is not a second table', () => {
    // Fuel, tolls, parking and repairs genuinely occur on a trip and off it.
    const both = createExpenseCategorySchema.parse({
      ...base,
      offeredOnTrips: true,
      offeredOnOverhead: true,
    });

    expect([both.offeredOnTrips, both.offeredOnOverhead]).toEqual([true, true]);
  });

  /**
   * REFUSED HERE AND IN THE DATABASE, and neither is redundant.
   *
   * Here, because the form sends both flags together, so a field-level 400
   * lands where the person can still act on it. In the database too, as
   * `expense_category_offered_somewhere`, because a request schema only ever
   * sees ONE request: two separate PATCHes that each clear one flag are
   * individually legal and collectively wrong, and no amount of care in a Zod
   * schema can see the second one coming. That half is asserted against
   * Postgres in `operation-expenses.test.ts`.
   */
  it('refuses a category offered nowhere, naming the field', () => {
    const result = createExpenseCategorySchema.safeParse({
      ...base,
      offeredOnTrips: false,
      offeredOnOverhead: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['offeredOnTrips']);
    expect(result.error?.issues[0]?.message).toMatch(/offered somewhere/);
  });
});

describe('the list query narrows to the side that is asking', () => {
  it('accepts either side', () => {
    expect(expenseCategoryListQuerySchema.parse({ offeredFor: 'trips' }).offeredFor).toBe('trips');
    expect(expenseCategoryListQuerySchema.parse({ offeredFor: 'overhead' }).offeredFor).toBe(
      'overhead',
    );
  });

  /**
   * Absent means EVERY category, which the management screen depends on: it is
   * the one caller that edits these flags, so it has to be able to see a
   * category that is currently offered nowhere it can reach.
   */
  it('defaults to no narrowing at all', () => {
    expect(expenseCategoryListQuerySchema.parse({}).offeredFor).toBeUndefined();
  });

  it('refuses a side that does not exist', () => {
    expect(() => expenseCategoryListQuerySchema.parse({ offeredFor: 'payroll' })).toThrow();
  });
});

/**
 * A PATCH writes what it names and nothing else.
 *
 * THE BUG THIS PINS was live and invisible. `.partial()` makes a field optional
 * but does NOT strip a `.default()` underneath it, so the obvious construction
 * — `createExpenseCategorySchema.partial()` — materialised every CREATE default
 * for every field the request omitted. `PATCH { name }` therefore rewrote
 * `requiresPayee`, `isActive` and the rest at their create values: renaming a
 * category quietly re-armed its payee rule, and reactivated a deactivated one.
 *
 * The web form masked it end to end, because `ResourcePage` sends every field
 * on every save. Nothing else talking to this API does.
 *
 * The fix is structural — the fields object carries no defaults and the create
 * schema layers them on — so these assertions are about the SHAPE of the
 * output, not about any one field.
 */
describe('a partial update carries no defaults into the write', () => {
  it('emits only the field it was given', () => {
    expect(updateExpenseCategorySchema.parse({ name: 'Renamed' })).toEqual({ name: 'Renamed' });
  });

  it('does not re-arm the payee rule on an unrelated rename', () => {
    const patch = updateExpenseCategorySchema.parse({ name: 'Renamed' });

    expect(patch).not.toHaveProperty('requiresPayee');
    expect(patch).not.toHaveProperty('isActive');
  });

  /**
   * The case that made this urgent: moving a category off overhead must not
   * quietly put it back on the trip forms.
   */
  it('does not flip the other applicability flag', () => {
    expect(updateExpenseCategorySchema.parse({ offeredOnOverhead: false })).toEqual({
      offeredOnOverhead: false,
    });
  });

  /**
   * `sortOrder` is the one field whose transform must survive into the patch: a
   * cleared number input means "put it back to 10" on an edit exactly as it
   * does on a create.
   */
  it('still turns a cleared sort order into the default', () => {
    expect(updateExpenseCategorySchema.parse({ sortOrder: null }).sortOrder).toBe(
      DEFAULT_EXPENSE_CATEGORY_SORT_ORDER,
    );
  });

  it('still refuses a patch that would leave the category offered nowhere', () => {
    expect(() =>
      updateExpenseCategorySchema.parse({ offeredOnTrips: false, offeredOnOverhead: false }),
    ).toThrow();
  });
});
