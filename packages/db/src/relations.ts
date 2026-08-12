/**
 * Accessors for relations the database keeps to at most one live row, but
 * Prisma types as an array.
 *
 * WHY THE ARRAYS EXIST. `shipment.liquidations`, `user.profiles` and
 * `crewMember.logins` are one-to-one in the domain. They are enforced by
 * PARTIAL unique indexes — `UNIQUE (...) WHERE "deletedAt" IS NULL` — so that
 * soft-deleting a row releases its slot and a shipment can be re-liquidated, a
 * user re-profiled, a crew member given a replacement login. Prisma cannot
 * express partial uniqueness, so it sees an ordinary one-to-many and generates
 * an array.
 *
 * The alternative was a full unique index, which types cleanly as one-to-one
 * and then permanently blocks the slot: a voided liquidation would stop that
 * shipment ever being liquidated again. Correct semantics, awkward types, and
 * this file is where the awkwardness is paid off — once, here, rather than at
 * every call site.
 *
 * These helpers assume the read that produced `rows` went through the
 * soft-delete extension, which is the only way to get a client in this
 * monorepo. Deleted rows are therefore already filtered out, and more than one
 * survivor means the partial unique index is missing or was dropped — a
 * corrupt database, not a case to handle gracefully.
 */

export class MultipleLiveRowsError extends Error {
  constructor(
    readonly relation: string,
    readonly count: number,
  ) {
    super(
      `Expected at most one live ${relation}, found ${count}. ` +
        `The partial unique index backing this relation is missing or has been dropped.`,
    );
    this.name = 'MultipleLiveRowsError';
  }
}

export class MissingLiveRowError extends Error {
  constructor(readonly relation: string) {
    super(`Expected exactly one live ${relation}, found none.`);
    this.name = 'MissingLiveRowError';
  }
}

/**
 * The single live row, or null.
 *
 * Use when absence is ordinary — a shipment that has not been liquidated yet,
 * a crew member with no portal login.
 */
export function liveOne<T>(rows: readonly T[], relation: string): T | null {
  if (rows.length > 1) {
    throw new MultipleLiveRowsError(relation, rows.length);
  }
  return rows[0] ?? null;
}

/**
 * The single live row, or throw.
 *
 * Use when absence is a bug — reading the profile of a user the caller just
 * created, say. Failing here beats propagating a null into something that
 * renders it as "undefined" three layers later.
 */
export function liveOneOrThrow<T>(rows: readonly T[], relation: string): T {
  const row = liveOne(rows, relation);
  if (row === null) {
    throw new MissingLiveRowError(relation);
  }
  return row;
}
