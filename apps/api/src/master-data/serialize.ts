import type { Prisma } from '@eztruckr/db';

/**
 * Row-to-response conversions.
 *
 * Two things never cross the wire as JSON numbers:
 *
 *   - Money and rates. They are Postgres DECIMALs; a JSON number is an
 *     IEEE-754 double, so serialising ₱18,000.4567 as a number reintroduces
 *     exactly the float error the schema went to trouble to avoid.
 *   - Physical quantities that are also DECIMAL (capacityKg, distanceKm). Not
 *     money, but the same rounding applies, and a mixed convention is worse
 *     than a strict one.
 *
 * Dates go out as ISO-8601 UTC. Asia/Manila is applied at the very edge, in
 * the browser, by `formatDateTime`.
 */

export function decimalToString(value: Prisma.Decimal | null): string | null {
  return value === null ? null : value.toString();
}

export function dateToIso(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

/** The audit columns every business row carries, in their response shape. */
export interface AuditRow {
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  updatedBy: string | null;
}

export function auditFields(row: AuditRow) {
  return {
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
  };
}
