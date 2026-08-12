import currency from 'currency.js';

/**
 * The single currency.js configuration for EZTruckr. Import `money()` from
 * here everywhere; never call `currency(...)` directly, or precision will
 * drift between call sites and figures will stop reconciling.
 */
const MONEY_SETTINGS: currency.Options = {
  symbol: '₱',
  precision: 2,
  separator: ',',
  decimal: '.',
};

/**
 * Anything that can safely become money.
 *
 * `number` is deliberately excluded. A money value must never exist as a
 * plain JS number between reading and writing, so the boundary is enforced by
 * the type system rather than by discipline. Prisma's `Decimal` satisfies
 * `{ toString(): string }` and so is accepted directly.
 */
export type MoneyInput = string | currency | { toString(): string };

/**
 * A percentage/rate multiplier such as 0.25 or 0.075.
 *
 * Rates are NOT money — they are never wrapped in a currency instance. They
 * arrive as Prisma `Decimal` (or its string form) and are handed straight to
 * `currency.multiply()`.
 */
export type RateInput = string | { toString(): string };

/** Wrap a value as PHP money at the one configured precision. */
export function money(value: MoneyInput): currency {
  return currency(value.toString(), MONEY_SETTINGS);
}

/** Money zero — handy as a reduce seed. */
export function zero(): currency {
  return money('0');
}

/**
 * Serialise money for storage in a Prisma `Decimal` column.
 *
 * currency.js `toString()` yields a plain fixed-2 string ("1822.50"), with no
 * separator and no symbol, which is exactly what Postgres `numeric` wants.
 * Never persist `.value` — that is a float.
 */
export function toDecimalString(value: currency): string {
  return value.toString();
}

/**
 * Multiply money by a rate, rounding to 2dp.
 *
 * Every step of the commission chain stores its result, so each step rounds
 * before feeding the next. That is what makes the stored figures reproducible
 * on a calculator: base x rate really does equal the stored commission.
 */
export function multiplyByRate(base: MoneyInput, rate: RateInput): currency {
  // The rate is passed through as a plain multiplier, never as money.
  return money(base).multiply(Number(rate.toString()));
}

/** Sum a list of money values, left to right, at 2dp throughout. */
export function sum(values: readonly MoneyInput[]): currency {
  return values.reduce<currency>((total, value) => total.add(money(value)), zero());
}

/** Format for display: "₱1,822.50". Display only — never round-trip this. */
export function formatMoney(value: MoneyInput): string {
  return money(value).format();
}

/** Format a rate as a percentage for display: 0.075 -> "7.5%". */
export function formatRate(rate: RateInput): string {
  const asNumber = Number(rate.toString()) * 100;
  return `${Number(asNumber.toFixed(4))}%`;
}

export type { currency as Money };
