import { z } from 'zod';
import { auditFieldsSchema, masterDataListQuerySchema, requiredText } from './common';

/**
 * The two places money gets classified, and therefore the two places a
 * category can be OFFERED.
 *
 * A STRING UNION RATHER THAN A CODE SET, on the `RemovalOutcome` rule: a code
 * set is a SMALLINT with a CHECK and a column comment behind it, and this value
 * is never written to a column. What the database stores is a pair of booleans,
 * because a category is legitimately offered in both places — fuel, tolls and
 * repairs all happen on a trip and off it — and one column that had to pick a
 * side could not say so.
 */
export const EXPENSE_CATEGORY_USES = ['trips', 'overhead'] as const;

export const expenseCategoryUseSchema = z.enum(EXPENSE_CATEGORY_USES);
export type ExpenseCategoryUse = z.infer<typeof expenseCategoryUseSchema>;

/**
 * Where an unordered category lands. Matches the column default in Postgres,
 * so the API and a direct insert agree.
 */
export const DEFAULT_EXPENSE_CATEGORY_SORT_ORDER = 10;

export const expenseCategorySchema = auditFieldsSchema.extend({
  id: z.string(),
  name: z.string(),
  requiresReceipt: z.boolean(),
  requiresPayee: z.boolean(),
  defaultCommissionable: z.boolean(),
  /**
   * Where this category is OFFERED. See the create schema for the argument;
   * `offeredFor` on the list query is how a picker asks for its own side.
   */
  offeredOnTrips: z.boolean(),
  offeredOnOverhead: z.boolean(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});

export type ExpenseCategory = z.infer<typeof expenseCategorySchema>;

const expenseCategoryFields = z.object({
  name: requiredText(120),
  requiresReceipt: z.boolean(),
  /**
   * Whether a disbursement in this category must name who was paid.
   *
   * Unlike `requiresReceipt`, this one is ENFORCED rather than stated — a
   * missing receipt is a judgement call for the approver, a missing payee is a
   * cost nobody can reconcile against a supplier statement.
   *
   * Defaults to true so relaxing a category is deliberate. The value is copied
   * onto each row it governs at write time and never read back live, so
   * changing it here affects new rows only.
   */
  requiresPayee: z.boolean(),
  /**
   * Default for the commissionable flag when this category is used as a
   * billable expense. The per-row flag on the expense still wins.
   */
  defaultCommissionable: z.boolean(),
  /**
   * WHERE THIS CATEGORY IS OFFERED, and the reason the two ledgers share one
   * table at all.
   *
   * A trip's money and the company's overhead are classified in the same terms
   * — fuel is fuel whether it went into a truck on a job or the office pickup —
   * so splitting the table would make "what did we spend on repairs this year"
   * a UNION over two lists whose names somebody has to keep in step by hand.
   * What was genuinely missing was not a second table but a statement of where
   * each category APPLIES, and these are it.
   *
   * BOTH ARE ALLOWED, which is the case that rules a second table out. Fuel,
   * tolls, parking and repairs really do occur on both sides. Neither is
   * allowed: a category offered nowhere cannot be filed against and would only
   * ever be a row somebody has to explain — refused by
   * `expense_category_offered_somewhere`.
   *
   * THE DEFAULTS ARE NOT SYMMETRIC, deliberately. Every category that existed
   * before overhead did was a trip category, so `true`/`false` leaves all of
   * them exactly as they were — and, more to the point, keeps a crew member's
   * liquidation picker showing what it showed yesterday. Marking one as
   * overhead is then a deliberate act, the same argument that has
   * `requiresPayee` default to the strict answer.
   *
   * NOT FROZEN ONTO THE ROWS IT GOVERNS, unlike `requiresPayee`. That one is a
   * rule about what a written row had to contain, so it has to keep saying what
   * it was; this decides what a picker OFFERS, which is the `isActive`
   * question. Un-ticking it later leaves every past row reading correctly and
   * simply stops the category being chosen again.
   */
  offeredOnTrips: z.boolean(),
  offeredOnOverhead: z.boolean(),
  /**
   * Optional, and 10 rather than 0 when it is left out.
   *
   * The seeded categories are spaced 10 apart, so a category added without
   * thinking about order lands beside the first one instead of jumping ahead
   * of everything — and a 0 default made "I didn't say" indistinguishable from
   * "put this first". A gap of 10 also leaves room to slot something between
   * two existing categories without renumbering the rest.
   *
   * `nullish().transform()` rather than `default()`, because those two are not
   * the same thing here. A cleared number input reaches the API as an explicit
   * NULL, not as an absent field, and `.default()` only fires on `undefined` —
   * so a plain default would have rejected the very case this is meant to
   * serve, with a type error about null at that.
   */
  sortOrder: z
    .number()
    .int()
    .min(0)
    .max(9999)
    .nullish()
    .transform((value) => value ?? DEFAULT_EXPENSE_CATEGORY_SORT_ORDER),
  isActive: z.boolean(),
});

/**
 * A category offered nowhere cannot be filed against from any screen, so it is
 * a row that silently does nothing — found months later by somebody wondering
 * why their category never appears.
 *
 * REFUSED IN TWO PLACES, AND NEITHER IS REDUNDANT. Here, because the form sends
 * both flags together and a field-level 400 lands where the person can still
 * act on it. And in the database, as `expense_category_offered_somewhere`,
 * because a request schema only ever sees ONE request: two separate PATCHes
 * that each clear one flag are individually legal and collectively wrong, and
 * no amount of care in a Zod schema can see the second one coming.
 *
 * Written as a `superRefine` on the FIELDS object rather than on the create
 * schema, so the partial used for updates can carry the same rule — a refined
 * schema has no `.partial()`.
 */
const offeredSomewhere = (
  value: { offeredOnTrips?: boolean; offeredOnOverhead?: boolean },
  ctx: z.RefinementCtx,
): void => {
  // `undefined` means this PATCH did not mention the field, so whatever is
  // already on the row stands and this request cannot be the one that empties
  // it. Only an explicit false on both counts is refusable here.
  if (value.offeredOnTrips === false && value.offeredOnOverhead === false) {
    ctx.addIssue({
      code: 'custom',
      path: ['offeredOnTrips'],
      message:
        'A category has to be offered somewhere. Choose trips, operation expenses, or both — or deactivate it instead.',
    });
  }
};

/**
 * THE DEFAULTS LIVE ON THE CREATE SCHEMA ALONE, and that placement is
 * load-bearing rather than tidy.
 *
 * `.partial()` makes a field optional; it does NOT strip a `.default()`
 * underneath, so a defaulted field still materialises its default when a PATCH
 * omits it. Built the obvious way — `createExpenseCategorySchema.partial()` —
 * this schema turned `PATCH { name }` into a write of every other column at its
 * CREATE value: a renamed category silently got `requiresPayee` back, and a
 * category moved off overhead silently reappeared on the trip forms. The web
 * form hides it, because `ResourcePage` sends every field every time; anything
 * else talking to this API does not.
 *
 * So the fields object above carries no defaults and is what the PATCH is built
 * from, and the create schema layers them on. An absent field then stays absent
 * all the way to Prisma, which leaves the column alone.
 *
 * `sortOrder` is deliberately NOT layered here: its `nullish().transform()` has
 * to apply on both paths, because a cleared number input means "put it back to
 * 10" whether the row is new or not. It reaches Prisma as a value only when the
 * request actually mentions it.
 */
export const createExpenseCategorySchema = expenseCategoryFields
  .extend({
    requiresReceipt: z.boolean().default(true),
    requiresPayee: z.boolean().default(true),
    defaultCommissionable: z.boolean().default(false),
    offeredOnTrips: z.boolean().default(true),
    offeredOnOverhead: z.boolean().default(false),
    isActive: z.boolean().default(true),
  })
  .superRefine(offeredSomewhere);

export type CreateExpenseCategoryInput = z.infer<typeof createExpenseCategorySchema>;

export const updateExpenseCategorySchema = expenseCategoryFields
  .partial()
  .superRefine(offeredSomewhere);

export type UpdateExpenseCategoryInput = z.infer<typeof updateExpenseCategorySchema>;

/**
 * Listing categories, optionally narrowed to the side that is asking.
 *
 * `offeredFor` is what keeps "Office rent" out of a crew member's liquidation
 * picker and "Driver's meal" out of the overhead form. Absent means every
 * category, which is what the management screen wants — it is the one caller
 * that edits the flags and so must be able to see a category that is currently
 * offered nowhere it can reach.
 */
export const expenseCategoryListQuerySchema = masterDataListQuerySchema.extend({
  offeredFor: expenseCategoryUseSchema.optional(),
});

export type ExpenseCategoryListQuery = z.infer<typeof expenseCategoryListQuerySchema>;
