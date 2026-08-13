import { describe, expect, it } from 'vitest';
import {
  formatShipmentNumber,
  nextShipmentNumber,
  shipmentNumberDatePart,
  shipmentNumberSequence,
} from './shipment-number';

describe('the date part is the company’s day, not UTC’s', () => {
  /**
   * THE REASON THIS FILE EXISTS. Manila is UTC+8, so for the eight hours
   * either side of midnight the two calendars disagree — and those hours are
   * the working morning, not some edge case at 3am. Deriving the date from the
   * UTC instant would stamp every trip booked before 8am with yesterday's
   * number, every day, and nobody would notice until somebody tried to find a
   * trip by its date.
   */
  it('gives today’s Manila date for an instant that is still yesterday in UTC', () => {
    // 07:30 on the 13th in Manila is 23:30 on the 12th in UTC.
    expect(shipmentNumberDatePart(new Date('2026-08-12T23:30:00Z'))).toBe('20260813');
  });

  it('gives the same date either side of Manila midnight', () => {
    // 23:59 on the 13th, and one minute later.
    expect(shipmentNumberDatePart(new Date('2026-08-13T15:59:00Z'))).toBe('20260813');
    expect(shipmentNumberDatePart(new Date('2026-08-13T16:01:00Z'))).toBe('20260814');
  });

  it('pads single-digit months and days, so the string sorts chronologically', () => {
    expect(shipmentNumberDatePart(new Date('2026-01-05T04:00:00Z'))).toBe('20260105');
  });
});

describe('the sequence', () => {
  it('starts at 001 on a day with nothing on it', () => {
    expect(nextShipmentNumber('20260813', [])).toBe('20260813001');
  });

  it('follows the highest issued number, not the count', () => {
    // A gap means a trip was deleted. Filling it would put two trips behind
    // one label in whatever paperwork left the building first.
    expect(nextShipmentNumber('20260813', ['20260813001', '20260813003'])).toBe('20260813004');
  });

  it('ignores numbers issued on other days', () => {
    expect(nextShipmentNumber('20260813', ['20260812009', '20260814001'])).toBe('20260813001');
  });

  /**
   * Numbers predating the generator were free text, and there is no reading of
   * "MNL-0042" that yields a sequence. Skipping them is the only honest
   * answer; treating an unparseable tail as 0 would be the same thing said
   * confidently.
   */
  it('ignores a hand-typed number that happens to start with today’s digits', () => {
    expect(nextShipmentNumber('20260813', ['20260813-URGENT', '20260813002'])).toBe('20260813003');
  });

  it('grows past three digits rather than refusing the thousandth trip', () => {
    expect(formatShipmentNumber('20260813', 1000)).toBe('202608131000');
    // And the wider number still parses, so the day after keeps counting.
    expect(nextShipmentNumber('20260813', ['202608131000'])).toBe('202608131001');
  });
});

describe('parsing back', () => {
  it('reads its own output', () => {
    expect(shipmentNumberSequence('20260813007', '20260813')).toBe(7);
  });

  it('returns null for another day and for free text', () => {
    expect(shipmentNumberSequence('20260812007', '20260813')).toBeNull();
    expect(shipmentNumberSequence('SHP-007', '20260813')).toBeNull();
  });
});
