/**
 * Which of a set of reference numbers appear on more than one live row.
 *
 * REPORTED, NEVER REFUSED, and that is the whole design. A reference is what
 * somebody wrote on a piece of paper: one bank transfer legitimately covers two
 * crew members, and one check legitimately settles two trips, so a unique index
 * would refuse a true record. The far commoner cause of a repeat is the same
 * slip entered twice — which nothing else catches, because the amounts and the
 * dates differ. Stating it lets the person holding the slip decide which of the
 * two they have.
 *
 * SHARED BECAUSE THE RULE IS SHARED. Allowances and client payments both ask
 * this question, and the two subtle parts — matching case-insensitively, and
 * counting across every trip rather than only this one — are exactly the parts
 * that would drift if each service kept its own copy. The delegate is passed in
 * so each caller searches its own table; nothing else differs.
 *
 * SEARCHED ACROSS EVERY TRIP, deliberately. A deposit slip entered twice
 * usually lands on two different shipments, which is precisely when nobody
 * notices. Soft-deleted rows are excluded by the client extension — a reference
 * freed by a correction should stop warning about itself.
 */

interface HasReference {
  referenceNumber: string | null;
}

/**
 * The `where.OR` a reference lookup needs, matched case-insensitively.
 *
 * ONE `equals` PER REFERENCE RATHER THAN A SINGLE `in`, because `in` is exact:
 * "BDO-4417" and "bdo-4417" are the same slip typed by two people, and a check
 * that only caught identical spelling would miss the duplicate at exactly the
 * moment two people recorded it. The list is the references already on one
 * trip, so it is a handful of terms and not a scan of the column.
 */
export function referenceFilter(references: readonly string[]) {
  return references.map((reference) => ({
    referenceNumber: { equals: reference, mode: 'insensitive' as const },
  }));
}

export async function repeatedReferenceNumbers(
  rows: readonly HasReference[],
  lookUp: (references: readonly string[]) => Promise<readonly HasReference[]>,
): Promise<Set<string>> {
  const references = [
    ...new Set(rows.map((row) => row.referenceNumber).filter((value) => value !== null)),
  ];

  if (references.length === 0) {
    return new Set();
  }

  const matches = await lookUp(references);
  const seen = new Map<string, number>();

  for (const match of matches) {
    const key = normaliseReference(match.referenceNumber);
    if (key === null) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }

  return new Set([...seen].filter(([, count]) => count > 1).map(([reference]) => reference));
}

/**
 * A reference as the duplicate check compares it: trimmed, lowercased, and null
 * when there is nothing left. The web forms normalise the same way as the value
 * is typed, so the warning before saving and the warning after it agree.
 */
export function normaliseReference(reference: string | null): string | null {
  const trimmed = reference?.trim().toLowerCase();

  return trimmed ? trimmed : null;
}
