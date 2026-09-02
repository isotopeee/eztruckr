import type { ProfitAndLoss } from '@eztruckr/types';
import { apiFetch, queryString } from './api-client';

/**
 * What the business made over a period.
 *
 * ITS OWN FILE, beside `operation-expense-api.ts` and for the same reason
 * that one is not in `shipment-api.ts`: nothing here takes a shipment id. The
 * report is about all of them at once, which is a different resource.
 *
 * NO ARITHMETIC, as everywhere else in `lib/`. Every figure — the two margins
 * included — arrives computed as a decimal string. The screen formats and
 * subtracts nothing, which is what stops a browser doing float arithmetic on
 * money and reporting a different bottom line than the API.
 */

export interface ProfitAndLossFilters {
  /** Inclusive lower bound, as an ISO instant. */
  from?: string;
  /** EXCLUSIVE upper bound. The API's window is half-open; see its schema. */
  to?: string;
}

export const profitAndLossKeys = {
  all: ['profit-and-loss'] as const,
  report: (filters: ProfitAndLossFilters) => ['profit-and-loss', 'report', filters] as const,
};

export function fetchProfitAndLoss(filters: ProfitAndLossFilters): Promise<ProfitAndLoss> {
  return apiFetch<ProfitAndLoss>(
    `/profit-and-loss${queryString({ from: filters.from, to: filters.to })}`,
  );
}

/**
 * The API's half-open window, from the two dates a person actually picked.
 *
 * THE SCREEN'S UPPER BOUND IS INCLUSIVE AND THE API'S IS NOT, and this function
 * is the whole of the translation. Somebody choosing "1 August to 31 August"
 * means the 31st counts; the API means `< to`, so passing their date straight
 * through would silently drop the last day of every period — a month short by
 * one day's freight, which reconciles to nothing and looks entirely plausible.
 *
 * `/operation-expenses` avoids the same trap by offering a MONTH rather than
 * two dates, which is right for a ledger somebody scrolls month by month. A
 * P&L is asked for over arbitrary periods — a quarter, a year, the six weeks
 * before a rate review — so the dates are offered and the edge is handled here
 * instead, in one place, rather than by asking the user to understand it.
 *
 * Both bounds are optional and are built as UTC midnight, the same rule the
 * expense form builds `spentAt` by, so a row dated the first of the month and
 * the window meant to contain it are constructed alike.
 */
export function windowFromDates(from: string, toInclusive: string): ProfitAndLossFilters {
  return {
    from: isDate(from) ? new Date(`${from}T00:00:00.000Z`).toISOString() : undefined,
    to: isDate(toInclusive) ? dayAfter(toInclusive) : undefined,
  };
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** Midnight on the day after, which is the exclusive bound that includes `date`. */
function dayAfter(date: string): string {
  const bound = new Date(`${date}T00:00:00.000Z`);
  bound.setUTCDate(bound.getUTCDate() + 1);

  return bound.toISOString();
}
