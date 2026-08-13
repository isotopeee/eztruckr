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
 * RENUMBERED ONCE, in Phase 5, by explicit decision — the second and last time
 * this has been done to any code set. Phase 2 shipped SUBMITTED 1 / APPROVED 2 /
 * FINALIZED 3, before this lifecycle was specified. Phase 5 first appended
 * PENDING at 4 and retired 3, then renumbered to the natural order above on the
 * user's instruction, while the only `liquidation` rows in existence were
 * development test data. The remapping is in migration
 * `20260813030000_renumber_liquidation_status`, which rewrites stored rows in a
 * single statement rather than leaving any to be reinterpreted.
 *
 * CODES ARE PERMANENT FROM HERE. The rule protects stored rows, and the window
 * in which there were none has closed. Append; never renumber.
 */
export const LiquidationStatus = {
  PENDING: 1,
  SUBMITTED: 2,
  APPROVED: 3,
} as const;

export type LiquidationStatus = (typeof LiquidationStatus)[keyof typeof LiquidationStatus];

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
 * Explicit progression. It happens to match the numbers today; the next status
 * appended to this set will not, and nothing here reads the number anyway.
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
