-- PENDING_LIQUIDATION (5) and LIQUIDATED (6) are retired as shipment statuses.
--
-- Both restated, on the shipment, what its liquidation accounts already say.
-- Where a trip's paperwork stands is now read from `liquidation.status` alone,
-- and the lifecycle runs DELIVERED -> CLOSED, guarded by the rows.
--
-- Every row at either code had been delivered (both were reachable only
-- through delivery), so DELIVERED is what each one now is. `deliveredAt` was
-- already set on them and is left as it was.
--
-- The codes themselves are never reused. The CHECK below stops anything
-- writing them, including a restore of a backup taken before this ran.

UPDATE shipment
   SET status = 4
 WHERE status IN (5, 6);

ALTER TABLE shipment DROP CONSTRAINT shipment_status_code_valid;
ALTER TABLE shipment ADD CONSTRAINT shipment_status_code_valid CHECK ((status = ANY (ARRAY[1, 2, 3, 4, 7])));
