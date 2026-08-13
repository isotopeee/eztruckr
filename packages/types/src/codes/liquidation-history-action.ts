import { defineCodeSet } from './code-set';

/**
 * What happened to a liquidation, one row per event. Stored as
 * `liquidation_history.action` SMALLINT.
 *
 * Two actions, because these are the two that a status column cannot record:
 * both of them leave the liquidation at a status it has held before, so without
 * this table a returned-and-resubmitted liquidation is indistinguishable from
 * one that was submitted for the first time.
 *
 * That distinction is the whole reason there is no `RETURNED` status. The
 * dashboard's "returned for correction" filter is PENDING with prior history;
 * the crew portal shows the latest RETURNED row's reason. Both read this table.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const LiquidationHistoryAction = {
  SUBMITTED: 1,
  RETURNED: 2,
} as const;

export type LiquidationHistoryAction =
  (typeof LiquidationHistoryAction)[keyof typeof LiquidationHistoryAction];

const meta = defineCodeSet('LiquidationHistoryAction', LiquidationHistoryAction);

export const LIQUIDATION_HISTORY_ACTION_CODES = meta.codes;
export const isLiquidationHistoryAction = meta.isValid;
export const liquidationHistoryActionSchema = meta.schema;

export const LIQUIDATION_HISTORY_ACTION_LABELS: Readonly<Record<LiquidationHistoryAction, string>> =
  {
    [LiquidationHistoryAction.SUBMITTED]: 'Submitted by crew',
    [LiquidationHistoryAction.RETURNED]: 'Returned for correction',
  };

/**
 * Whether the reason column must be populated for this action.
 *
 * A return without a reason is the crew being told to try again with no idea
 * what was wrong, so the requirement is also a CHECK constraint
 * (`liquidation_history_reason_matches_action`) rather than only a service
 * rule. A submission carries no reason at all — an empty box nobody fills in
 * would only dilute the one that matters.
 */
export function requiresReason(action: LiquidationHistoryAction): boolean {
  return action === LiquidationHistoryAction.RETURNED;
}
