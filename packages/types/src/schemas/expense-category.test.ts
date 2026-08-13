import { describe, expect, it } from 'vitest';
import {
  createExpenseCategorySchema,
  DEFAULT_EXPENSE_CATEGORY_SORT_ORDER,
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
