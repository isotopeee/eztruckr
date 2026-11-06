-- Whether a trip is an import or an export.
--
-- Nullable and not backfilled: no existing trip recorded it, and stamping a
-- guess on the history would read like paperwork that was never there.

ALTER TABLE shipment ADD COLUMN "shipmentDirection" SMALLINT;

ALTER TABLE shipment ADD CONSTRAINT shipment_direction_code_valid
  CHECK (("shipmentDirection" = ANY (ARRAY[1, 2])));

COMMENT ON COLUMN shipment."shipmentDirection" IS
  'Code set ShipmentDirection (1 IMPORT, 2 EXPORT). Null when the booking did not say, which is every trip recorded before the column existed.';
