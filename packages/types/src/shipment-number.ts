import { APP_TIMEZONE } from './app-timezone';

/**
 * The shipment number: `20260813001` — the day the trip was booked, then its
 * position within that day.
 *
 * GENERATED, NEVER TYPED. It was a free-text field until now, which meant the
 * number was whatever the person booking happened to write and two people
 * booking at once could disagree. Generating it makes the number mean
 * something — it sorts chronologically as text, it tells you the booking date
 * without a join, and a gap in a day's sequence is a deleted trip rather than
 * a typo.
 *
 * THE DATE IS THE COMPANY'S, NOT UTC'S. Manila is UTC+8, so a trip booked at
 * 9am on the 13th is stored as 01:00Z on the 13th, but one booked at 7am is
 * 23:00Z on the 12th. Deriving the date part from the UTC instant would give
 * the whole morning shift yesterday's number, every day. The instant stays UTC
 * in the column; only the label is local.
 *
 * The sequence is padded to three digits and DELIBERATELY NOT CAPPED there. A
 * 1000th trip in one day yields `202608131000`, which is longer but still
 * sorts correctly within its day and still parses back — refusing the booking
 * because the format ran out of room would be the format dictating to the
 * business.
 */

export const SHIPMENT_NUMBER_SEQUENCE_DIGITS = 3;

/** `YYYYMMDD` for an instant, read in the company's own timezone. */
export function shipmentNumberDatePart(at: Date, timeZone: string = APP_TIMEZONE): string {
  // en-CA is used purely because its short date format IS YYYY-MM-DD; nothing
  // here is Canadian. `Intl` is the only thing in the runtime that can do a
  // timezone-correct calendar date without pulling in a date library.
  const formatted = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);

  return formatted.replace(/-/g, '');
}

export function formatShipmentNumber(datePart: string, sequence: number): string {
  return `${datePart}${String(sequence).padStart(SHIPMENT_NUMBER_SEQUENCE_DIGITS, '0')}`;
}

/**
 * The sequence inside a number already issued on `datePart`, or null if the
 * number belongs to another day — or to the era before numbers were generated,
 * when they were whatever somebody typed.
 */
export function shipmentNumberSequence(shipmentNumber: string, datePart: string): number | null {
  if (!shipmentNumber.startsWith(datePart)) return null;

  const tail = shipmentNumber.slice(datePart.length);

  if (!/^\d+$/.test(tail)) return null;

  return Number(tail);
}

/**
 * The next number for a day, given every number already issued on it.
 *
 * Takes the issued numbers rather than a count, and the caller is expected to
 * pass SOFT-DELETED ones too: a number that has been used is spent, and
 * reissuing it would put two different trips behind one label in whatever
 * paperwork left the building before the deletion.
 */
export function nextShipmentNumber(datePart: string, issued: readonly string[]): string {
  const highest = issued.reduce(
    (max, issuedNumber) => Math.max(max, shipmentNumberSequence(issuedNumber, datePart) ?? 0),
    0,
  );

  return formatShipmentNumber(datePart, highest + 1);
}
