import { defineCodeSet } from './code-set';

/**
 * Shipment lifecycle. Stored as `shipment.status` SMALLINT.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 *
 * HISTORICAL NOTE. Phase 2 shipped this set without PENDING_LIQUIDATION, which
 * gave LIQUIDATED code 5 and CLOSED code 6. Phase 4 renumbered them to the
 * values below, on an explicit decision: the permanence rule exists to stop a
 * renumber silently rewriting the meaning of stored rows, and at that moment
 * the `shipment` table was empty. Nothing was reinterpreted. The rule is back
 * in force now that shipments exist — from here the set is append-only.
 */
export const ShipmentStatus = {
  DRAFT: 1,
  DISPATCHED: 2,
  IN_TRANSIT: 3,
  DELIVERED: 4,
  PENDING_LIQUIDATION: 5,
  LIQUIDATED: 6,
  CLOSED: 7,
} as const;

export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];

const meta = defineCodeSet('ShipmentStatus', ShipmentStatus);

export const SHIPMENT_STATUS_CODES = meta.codes;
export const isShipmentStatus = meta.isValid;
export const shipmentStatusSchema = meta.schema;

export const SHIPMENT_STATUS_LABELS: Readonly<Record<ShipmentStatus, string>> = {
  [ShipmentStatus.DRAFT]: 'Draft',
  [ShipmentStatus.DISPATCHED]: 'Dispatched',
  [ShipmentStatus.IN_TRANSIT]: 'In transit',
  [ShipmentStatus.DELIVERED]: 'Delivered',
  [ShipmentStatus.PENDING_LIQUIDATION]: 'Pending liquidation',
  [ShipmentStatus.LIQUIDATED]: 'Liquidated',
  [ShipmentStatus.CLOSED]: 'Closed',
};

/**
 * Explicit progression, because order must never be inferred from the numeric
 * value. Appending a future status in the middle of the workflow would give it
 * a high code while belonging early in this list.
 */
export const SHIPMENT_STATUS_SEQUENCE: readonly ShipmentStatus[] = [
  ShipmentStatus.DRAFT,
  ShipmentStatus.DISPATCHED,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.PENDING_LIQUIDATION,
  ShipmentStatus.LIQUIDATED,
  ShipmentStatus.CLOSED,
];

/** Position in the workflow, or -1 if the status is not part of it. */
export function shipmentStatusRank(status: ShipmentStatus): number {
  return SHIPMENT_STATUS_SEQUENCE.indexOf(status);
}

/**
 * True when `candidate` is at or beyond `reference` in the workflow.
 * Use this instead of comparing codes with `>=`.
 */
export function shipmentStatusAtLeast(
  candidate: ShipmentStatus,
  reference: ShipmentStatus,
): boolean {
  return shipmentStatusRank(candidate) >= shipmentStatusRank(reference);
}

/**
 * Transitions a human may ask for, as `from -> to`.
 *
 * Two steps are deliberately absent, because no operator performs them:
 *
 *   DELIVERED -> PENDING_LIQUIDATION  happens the instant delivery is
 *     recorded, in the same write. The shipment is never left sitting in
 *     DELIVERED for a dispatcher to notice, so "awaiting liquidation" is a
 *     state you can query rather than the absence of a liquidation row.
 *
 *   PENDING_LIQUIDATION -> LIQUIDATED  is earned, not requested: it needs an
 *     approved liquidation AND computed commissions. The service applies it
 *     when the second of those two lands, from whichever side arrives last.
 *
 * The workflow only moves forward. Nothing here reopens a shipment, because
 * the money downstream — frozen rates, computed commissions, payout lines —
 * has no defined behaviour on the way back, and inventing one silently would
 * be worse than refusing.
 */
const ALLOWED_MANUAL_TRANSITIONS: Readonly<Record<ShipmentStatus, readonly ShipmentStatus[]>> = {
  [ShipmentStatus.DRAFT]: [ShipmentStatus.DISPATCHED],
  [ShipmentStatus.DISPATCHED]: [ShipmentStatus.IN_TRANSIT],
  [ShipmentStatus.IN_TRANSIT]: [ShipmentStatus.DELIVERED],
  [ShipmentStatus.DELIVERED]: [],
  [ShipmentStatus.PENDING_LIQUIDATION]: [],
  [ShipmentStatus.LIQUIDATED]: [ShipmentStatus.CLOSED],
  [ShipmentStatus.CLOSED]: [],
};

export function allowedManualTransitions(from: ShipmentStatus): readonly ShipmentStatus[] {
  return ALLOWED_MANUAL_TRANSITIONS[from];
}

export function isAllowedManualTransition(from: ShipmentStatus, to: ShipmentStatus): boolean {
  return ALLOWED_MANUAL_TRANSITIONS[from].includes(to);
}

/**
 * Recording delivery lands the shipment in PENDING_LIQUIDATION, not DELIVERED.
 * Callers ask for DELIVERED; this is what actually gets stored.
 */
export function statusAfterManualTransition(requested: ShipmentStatus): ShipmentStatus {
  return requested === ShipmentStatus.DELIVERED ? ShipmentStatus.PENDING_LIQUIDATION : requested;
}

/**
 * Statuses at which the booking — the rate chain included — is still an
 * ordinary edit.
 *
 * Once a shipment is dispatched the crew is on the road against agreed
 * figures, so the gross rate stops being a draft and becomes a commitment.
 */
export function isRateChainEditable(status: ShipmentStatus): boolean {
  return status === ShipmentStatus.DRAFT;
}

/**
 * Statuses at which an agreed rate may still be CORRECTED.
 *
 * A different question from `isRateChainEditable`, and the pair is the point.
 * That one says when the figure is still a proposal, and dispatch stops it. A
 * broker who confirms a different cut the next morning, or a gross rate typed
 * with a zero missing, is neither a proposal nor a thing the crew being on the
 * road can fix — the rate was simply recorded wrong, and refusing to correct it
 * means the trip's revenue is knowingly false for ever.
 *
 * ONCE THE SAME BOUND AS THE CHARGES, AND NO LONGER. Charges now stay open to
 * CLOSED, because a port fee is discovered late and the record is wrong
 * without it. A rate is not discovered late — it was agreed with the broker on
 * the day — so nothing moved here, and the parity that used to carry this line
 * is gone rather than merely restated. What still stands is the reason:
 * LIQUIDATED means every account was approved against this figure.
 *
 * And the harder bound is not here at all — a correction is refused once any
 * commission has been PAID, which is a fact about the payout rather than about
 * the status, so `assertNothingPaid` enforces it and this cannot.
 *
 * Restricted by role as well: see `CAN_EDIT_RATE_CHAIN`.
 */
export function isRateChainCorrectable(status: ShipmentStatus): boolean {
  return !shipmentStatusAtLeast(status, ShipmentStatus.LIQUIDATED);
}

/**
 * Statuses at which the facts that IDENTIFY the trip may still be corrected:
 * the client, the date it ran, the route, the lane and the container number.
 *
 * A THIRD RULE ALONGSIDE THE TWO ABOVE, because it answers a third question.
 * `isRateChainEditable` is about a figure that stops being a proposal at
 * dispatch; `isRateChainCorrectable` is about fixing a figure that was agreed
 * and recorded wrong. These fields are neither — they are transcription of
 * paperwork that mostly arrives AFTER the booking, and the container number in
 * particular is what a client quotes down the phone. A trip filed under the
 * wrong client is one nobody can find, and refusing the correction does not
 * make the record true, it just makes it permanently false.
 *
 * BOUNDED AT LIQUIDATED, where the trip's record closes for good — the same
 * point as the rate correction above, and for the same reason. It was the
 * charges' bound too until they moved out to CLOSED; these did not follow,
 * because paperwork that renames a trip is not the same as a cost the trip
 * genuinely incurred. And as with the rate chain, the status is not the only
 * bound: changing the client or the route moves which commission RULE applies
 * (see `ruleMatches`), so those two are additionally refused once a commission
 * has been paid — a fact about the payout that no status can express.
 */
export function areBookingDetailsCorrectable(status: ShipmentStatus): boolean {
  return !shipmentStatusAtLeast(status, ShipmentStatus.LIQUIDATED);
}

/**
 * Charges and billable expenses stay open until the trip is CLOSED.
 *
 * THEY ARE DISCOVERED, NOT AGREED, which is what separates them from the two
 * rules above. Port fees and detention turn up en route, and the invoice for
 * them routinely lands after the liquidation has been approved. Refusing it
 * does not make the trip cheaper — it makes the record false and the client
 * under-invoiced, and there is no later trip to put the charge on, because a
 * charge belongs to this one or to none.
 *
 * WHICH LEAVES THE COMMISSION BASE, and the status was never what protected
 * it. `assertChargesEditable` also refuses once any commission has been PAID,
 * and that is the bound that matters: the cash has left, and the voucher
 * behind it has to keep reconciling. A computed-but-unpaid commission goes
 * stale rather than blocking — `commissionsStale` says so on the shipment, so
 * the recompute is prompted instead of being silently needed.
 *
 * Same bound as a company-paid expense, which reached it first and by the same
 * argument; see `CompanyPaidExpensesService` for why the two are still not one
 * service.
 */
export function areChargesEditable(status: ShipmentStatus): boolean {
  return status !== ShipmentStatus.CLOSED;
}

/**
 * Statuses at which removing a trip is an ORDINARY CORRECTION — the booking
 * form's own undo, available to everybody who may book one.
 *
 * DRAFT ALONE, and the bound is narrower than every other rule in this file
 * because it answers a different question. The three above ask what may still
 * be corrected about a trip that ran; this one asks whether the trip ever
 * happened. A draft has not been dispatched — nothing left the yard against its
 * figures and nobody is on the road holding paperwork that names it — so it is
 * a booking somebody typed, and a booking typed twice or against the wrong
 * client is the whole case this exists for.
 *
 * NOT A CEILING ON REMOVAL, which is the thing to read carefully: an
 * ADMINISTRATOR may remove a trip at any status, and this predicate has nothing
 * to say about that path. What it draws is the line between the two — below it
 * removal is dispatch correcting its own typing, above it an intervention by
 * the one role that answers for the record as a whole. Hence the name: this is
 * the DISPATCH half. See `CAN_REMOVE_DRAFT_SHIPMENTS` and
 * `CAN_REMOVE_ANY_SHIPMENT` for who each half is.
 *
 * NEITHER HALF IS THE WHOLE RULE, and neither can be. Dispatch is additionally
 * refused a draft that already carries a charge, a payment, released cash or an
 * adjustment; the administrator is refused any trip whose money has actually
 * moved — a paid commission, a paid adjustment, a recovered deduction. Both are
 * facts about rows rather than about status, so `ShipmentsService.remove`
 * enforces them and this predicate stays a statement about the workflow.
 */
export function isShipmentRemovableByDispatch(status: ShipmentStatus): boolean {
  return status === ShipmentStatus.DRAFT;
}
