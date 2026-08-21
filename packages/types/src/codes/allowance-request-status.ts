import { defineCodeSet } from './code-set';

/**
 * What has happened to a dispatch manager's request for trip cash. Stored as
 * `allowance_request.status` SMALLINT.
 *
 * THREE STATES, and the middle one is the whole point of the record:
 *
 *   PENDING   raised by dispatch, waiting on accounting. The truck is loading
 *             and nobody has been handed anything yet.
 *   APPROVED  accounting released the cash. The request names the `Allowance`
 *             row that came out of it, so the ask and the release are one
 *             chain rather than two facts somebody has to line up by eye.
 *   DECLINED  accounting refused, with a reason. The reason is required by a
 *             CHECK, not merely by this service.
 *
 * THERE IS NO `CANCELLED` STATE. A dispatch manager who no longer needs the
 * money removes the request while it is still PENDING — a soft delete, which
 * this system already keeps and can already read back. A fourth code would
 * behave identically to a removed row in every query and every screen, and the
 * one question it answers ("who called it off") is `deletedBy`.
 *
 * APPROVAL IS TERMINAL, and deliberately more terminal than a liquidation's.
 * There is no reversal here because there is nothing to reverse: the money
 * moved, and the record of it moving is the `Allowance`, which has its own
 * removal and its own effect on the custodian's variance. A request that could
 * be un-approved would be a second, quieter way to unwind a cash release.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const AllowanceRequestStatus = {
  PENDING: 1,
  APPROVED: 2,
  DECLINED: 3,
} as const;

export type AllowanceRequestStatus =
  (typeof AllowanceRequestStatus)[keyof typeof AllowanceRequestStatus];

const meta = defineCodeSet('AllowanceRequestStatus', AllowanceRequestStatus);

export const ALLOWANCE_REQUEST_STATUS_CODES = meta.codes;
export const isAllowanceRequestStatus = meta.isValid;
export const allowanceRequestStatusSchema = meta.schema;

export const ALLOWANCE_REQUEST_STATUS_LABELS: Readonly<Record<AllowanceRequestStatus, string>> = {
  [AllowanceRequestStatus.PENDING]: 'Awaiting accounting',
  [AllowanceRequestStatus.APPROVED]: 'Approved',
  [AllowanceRequestStatus.DECLINED]: 'Declined',
};

/**
 * Whether accounting has answered yet.
 *
 * Asked instead of comparing to PENDING, so that a fourth code appended later
 * cannot quietly be treated as still open by half the call sites and closed by
 * the other half.
 */
export function isAllowanceRequestDecided(status: AllowanceRequestStatus): boolean {
  return status !== AllowanceRequestStatus.PENDING;
}

/**
 * Whether the decision has to state why.
 *
 * A refusal with no reason is dispatch being told to try again with no idea
 * what to change, which is the same argument that makes a liquidation's return
 * reason mandatory. Backed by `allowance_request_decision_matches_status`, so
 * it is a property of the row and not of the service that wrote it.
 *
 * An approval carries no reason at all: the cash moved, and an empty box
 * beside every approval would only dilute the one that matters.
 */
export function requiresDeclineReason(status: AllowanceRequestStatus): boolean {
  return status === AllowanceRequestStatus.DECLINED;
}
