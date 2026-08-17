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

/**
 * A UTC instant as `YYYY-MM-DD` for an `<input type="date">`, read in Manila.
 *
 * THE TIMEZONE IS THE WHOLE POINT. A trip stored at 17:00Z is already tomorrow
 * in Manila, and `formatDate` above renders it as tomorrow — slicing the ISO
 * string instead would put yesterday's date in the field beside today's date on
 * screen, and saving that form would quietly move the trip back a day. What the
 * field shows has to be what the page shows.
 *
 * en-CA is used purely because its short date format IS `YYYY-MM-DD`, the same
 * trick and for the same reason as `shipmentNumberDatePart`.
 */
export function toDateInputValue(isoUtc: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(isoUtc));
}
