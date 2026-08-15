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
 * SAME BOUND AS THE CHARGES, deliberately, because it is the same reason: both
 * feed the commission base, so both stay open until the base is frozen for good
 * at LIQUIDATED. And the harder bound is not here at all — a correction is
 * refused once any commission has been PAID, which is a fact about the payout
 * rather than about the status, so `assertNothingPaid` enforces it and this
 * cannot.
 *
 * Restricted by role as well: see `CAN_EDIT_RATE_CHAIN`.
 */
export function isRateChainCorrectable(status: ShipmentStatus): boolean {
  return !shipmentStatusAtLeast(status, ShipmentStatus.LIQUIDATED);
}

/**
 * Charges and billable expenses stay open until the trip is liquidated —
 * port fees and detention are discovered en route, not at booking. Once
 * commissions are computed the base is frozen, so a later charge would make
 * the stored commission unreproducible.
 */
export function areChargesEditable(status: ShipmentStatus): boolean {
  return !shipmentStatusAtLeast(status, ShipmentStatus.LIQUIDATED);
}
