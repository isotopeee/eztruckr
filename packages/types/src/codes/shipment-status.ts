import { defineCodeSet } from './code-set';

/**
 * Shipment lifecycle. Stored as `shipment.status` SMALLINT.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const ShipmentStatus = {
  DRAFT: 1,
  DISPATCHED: 2,
  IN_TRANSIT: 3,
  DELIVERED: 4,
  LIQUIDATED: 5,
  CLOSED: 6,
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
