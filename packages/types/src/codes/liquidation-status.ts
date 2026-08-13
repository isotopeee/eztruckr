import { defineCodeSet } from './code-set';

/**
 * Liquidation lifecycle. Stored as `liquidation.status` SMALLINT.
 *
 * THREE STATES, and the shape of the set is the design:
 *
 *   PENDING    with the crew, awaiting their action. A liquidation is created
 *              here the moment the shipment is marked delivered, so "the crew
 *              still owe us paperwork" is a state you can filter on rather than
 *              the absence of a row.
 *   SUBMITTED  with accounting, awaiting review.
 *   APPROVED   costs post to the P&L and the liquidation locks.
 *
 * THERE IS NO `RETURNED` OR `REJECTED` STATE, deliberately. Accounting returns
 * a liquidation with a required reason and it goes back to PENDING, which
 * already means exactly that — with the crew, awaiting their action. A separate
 * state would behave identically to PENDING in every query, every guard and
 * every screen, and the one question it would answer ("was this returned?") is
 * answered better by `LiquidationHistory`, which also says when, by whom, and
 * why. Do not add one.
 *
 * THERE IS NO `FINALIZED` STATE either. Approval is the lock: an approved
 * liquidation may only move by being explicitly reversed, with a reason.
 *
 * CODES ARE PERMANENT — never renumbered, never reused, append only. Phase 2
 * shipped this set as SUBMITTED 1 / APPROVED 2 / FINALIZED 3, before the
 * lifecycle above was specified. PENDING is therefore APPENDED at 4 rather than
 * renumbering the set to read 1-2-3, even though the `liquidation` table was
 * empty and a renumber would have been safe. Order never comes from the numeric
 * value anywhere in this codebase — it comes from the sequence below — so the
 * only thing a renumber would have bought is a tidier-looking constant, at the
 * cost of the one rule that keeps stored rows meaning what they meant.
 */
export const LiquidationStatus = {
  PENDING: 4,
  SUBMITTED: 1,
  APPROVED: 2,
} as const;

export type LiquidationStatus = (typeof LiquidationStatus)[keyof typeof LiquidationStatus];

/**
 * Codes withdrawn from the set and never to be reused.
 *
 * 3 was FINALIZED, a fourth state the specification does not have. No row ever
 * held it. It is listed here — and pinned in `code-set.test.ts` — so that the
 * next code appended to this set is 5, and nobody re-allocates 3 to something
 * new and makes a historical row read as the wrong thing.
 */
export const RETIRED_LIQUIDATION_STATUS_CODES: readonly number[] = [3];

const meta = defineCodeSet('LiquidationStatus', LiquidationStatus);

export const LIQUIDATION_STATUS_CODES = meta.codes;
export const isLiquidationStatus = meta.isValid;
export const liquidationStatusSchema = meta.schema;

export const LIQUIDATION_STATUS_LABELS: Readonly<Record<LiquidationStatus, string>> = {
  [LiquidationStatus.PENDING]: 'Pending',
  [LiquidationStatus.SUBMITTED]: 'Submitted',
  [LiquidationStatus.APPROVED]: 'Approved',
};

/**
 * Explicit progression. PENDING carries the highest code and comes first, which
 * is precisely why order is never inferred from the number.
 */
export const LIQUIDATION_STATUS_SEQUENCE: readonly LiquidationStatus[] = [
  LiquidationStatus.PENDING,
  LiquidationStatus.SUBMITTED,
  LiquidationStatus.APPROVED,
];

export function liquidationStatusRank(status: LiquidationStatus): number {
  return LIQUIDATION_STATUS_SEQUENCE.indexOf(status);
}

export function liquidationStatusAtLeast(
  candidate: LiquidationStatus,
  reference: LiquidationStatus,
): boolean {
  return liquidationStatusRank(candidate) >= liquidationStatusRank(reference);
}

/**
 * Every move a person may ask for, as `from -> to`.
 *
 * Two of these run backwards, and both are the specification rather than an
 * escape hatch:
 *
 *   SUBMITTED -> PENDING   accounting returning work to the crew. A reason is
 *                          required and lands in `LiquidationHistory`.
 *   APPROVED  -> SUBMITTED reversing an approval. A reason is required, it is
 *                          written to the audit trail, and it is refused once
 *                          the money behind the approval has actually moved.
 *
 * PENDING -> APPROVED is absent on purpose: approving work the crew never
 * submitted would skip the only step at which they assert the figures are
 * theirs.
 */
const ALLOWED_LIQUIDATION_TRANSITIONS: Readonly<
  Record<LiquidationStatus, readonly LiquidationStatus[]>
> = {
  [LiquidationStatus.PENDING]: [LiquidationStatus.SUBMITTED],
  [LiquidationStatus.SUBMITTED]: [LiquidationStatus.APPROVED, LiquidationStatus.PENDING],
  [LiquidationStatus.APPROVED]: [LiquidationStatus.SUBMITTED],
};

export function allowedLiquidationTransitions(
  from: LiquidationStatus,
): readonly LiquidationStatus[] {
  return ALLOWED_LIQUIDATION_TRANSITIONS[from];
}

export function isAllowedLiquidationTransition(
  from: LiquidationStatus,
  to: LiquidationStatus,
): boolean {
  return ALLOWED_LIQUIDATION_TRANSITIONS[from].includes(to);
}

/**
 * Whether the lines and the totals may still be edited.
 *
 * Approval is the lock, so this is the one place that decides it. Everything
 * else — adding a line, attaching a receipt, issuing a further allowance
 * against the same trip — asks this rather than comparing statuses itself.
 */
export function isLiquidationEditable(status: LiquidationStatus): boolean {
  return status !== LiquidationStatus.APPROVED;
}

/**
 * Whether the liquidation's expenses are recognised as P&L cost.
 *
 * Cost recognition is DERIVED from the status rather than posted into a ledger,
 * which is what makes "return -> resubmit -> approve posts exactly one set of
 * costs" true by construction: there is only ever one live liquidation per
 * shipment, and it either is approved or is not. A posting flag would be a
 * second place holding the same fact, free to disagree with it.
 */
export function isCostRecognised(status: LiquidationStatus): boolean {
  return status === LiquidationStatus.APPROVED;
}
