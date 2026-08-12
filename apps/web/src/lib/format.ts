import { APP_TIMEZONE, formatMoney } from '@eztruckr/types';

/**
 * Display helpers.
 *
 * The web app NEVER computes money — it only renders values the API already
 * computed. `formatMoney` is re-exported so components have a single import
 * and no reason to reach for currency.js themselves.
 */
export { formatMoney };

/** Render a UTC instant in Asia/Manila. */
export function formatDateTime(isoUtc: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: APP_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(isoUtc));
}

/** Render a UTC instant as a date only, in Asia/Manila. */
export function formatDate(isoUtc: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: APP_TIMEZONE,
    dateStyle: 'medium',
  }).format(new Date(isoUtc));
}
