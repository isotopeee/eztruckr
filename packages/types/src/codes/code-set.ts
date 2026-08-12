import { z } from 'zod';

/**
 * Enumerated values are stored as SMALLINT, never as Postgres enums.
 *
 * Each code set is declared exactly once, here in @eztruckr/types, as a frozen
 * const object plus a derived union type. The API and the web app both import
 * from this package, so a bare numeric literal should never appear anywhere
 * else in the codebase.
 *
 * CODES ARE PERMANENT. Once a value is assigned it is never renumbered and
 * never reused; new values are appended. Renumbering would silently rewrite
 * the meaning of every row already stored.
 *
 * Because codes are appended rather than ordered by meaning, never assume they
 * are contiguous or monotonic. Order-dependent logic ("a shipment cannot close
 * before it is liquidated") must compare against named constants, never
 * against raw numbers or by `<` on the code itself.
 */
export type CodeMap = Readonly<Record<string, number>>;

export interface CodeSetMeta<TCode extends number> {
  /** Every valid code, ascending. */
  readonly codes: readonly TCode[];
  /** Runtime guard, also used to validate values arriving from outside. */
  readonly isValid: (value: unknown) => value is TCode;
  /** Zod schema for DTOs. */
  readonly schema: z.ZodType<TCode>;
}

/**
 * Derives the runtime helpers for a code set. Keeping this generic means a new
 * code set is a single const object plus one call, with no chance of the
 * helpers drifting out of step with the values.
 */
export function defineCodeSet<const TMap extends CodeMap>(
  name: string,
  map: TMap,
): CodeSetMeta<TMap[keyof TMap]> {
  type TCode = TMap[keyof TMap];

  const codes = Object.freeze(
    (Object.values(map) as TCode[]).slice().sort((a, b) => a - b),
  ) as readonly TCode[];

  const lookup = new Set<number>(codes);

  const isValid = (value: unknown): value is TCode =>
    typeof value === 'number' && Number.isInteger(value) && lookup.has(value);

  const schema = z
    .number()
    .int()
    .refine(isValid, { message: `Invalid ${name} code` }) as unknown as z.ZodType<TCode>;

  return { codes, isValid, schema };
}

/**
 * Renders the SQL fragment a CHECK constraint uses for a code column.
 *
 * The migrations that create those constraints are static SQL, so the code
 * values necessarily appear there too — that is the one unavoidable
 * duplication. `code-set.test.ts` compares the live constraints against these
 * definitions so the two cannot drift apart unnoticed.
 */
export function codeCheckList(meta: CodeSetMeta<number>): string {
  return meta.codes.join(', ');
}
