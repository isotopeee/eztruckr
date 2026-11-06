import { defineCodeSet } from './code-set';

/**
 * Whether a trip carries an import or an export. Stored as
 * `shipment.shipmentDirection` SMALLINT, nullable: trips booked before the column
 * existed never said, and guessing would read like a recorded fact.
 *
 * Named `shipmentDirection` rather than `direction` because the shipment list
 * query already uses `direction` for sort order.
 *
 * Codes are permanent: never renumber, never reuse, append only.
 */
export const ShipmentDirection = {
  IMPORT: 1,
  EXPORT: 2,
} as const;

export type ShipmentDirection = (typeof ShipmentDirection)[keyof typeof ShipmentDirection];

const meta = defineCodeSet('ShipmentDirection', ShipmentDirection);

export const SHIPMENT_DIRECTION_CODES = meta.codes;
export const isShipmentDirection = meta.isValid;
export const shipmentDirectionSchema = meta.schema;

export const SHIPMENT_DIRECTION_LABELS: Readonly<Record<ShipmentDirection, string>> = {
  [ShipmentDirection.IMPORT]: 'Import',
  [ShipmentDirection.EXPORT]: 'Export',
};
