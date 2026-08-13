-- Many liquidations per shipment, each with a custodian.
--
-- THE DEFECT THIS FIXES is the one this codebase keeps finding: a column doing
-- two jobs with a convention holding it together. `liquidation` was one row per
-- shipment, so on a trip where the driver held ₱10,000 and the helper held
-- ₱3,000, a single `variance` could only ever say what the TRIP was short by —
-- never which of them owed it. `settlement`, built directly on that figure,
-- inherited the blindness, and the outstanding-allowances alert would name a
-- shipment while being structurally unable to name a person. Nothing could
-- express "the driver squared up and the helper has not".
--
-- Three changes, each making a relationship that was assumed into one the
-- database checks:
--
--   1. LIQUIDATION gains `custodianId` and loses the one-per-shipment index.
--      Nullable, because a trip's first liquidation is created at BOOKING,
--      before anybody is assigned to drive it.
--
--   2. ALLOWANCE gains `liquidationId` — which account a release is booked
--      against, and therefore whose variance it moves. Until now "total
--      advanced" was every release on the trip, which is exactly the blending
--      above.
--
--   3. SETTLEMENT moves from one-per-shipment to one-per-liquidation. Two
--      people each holding change cannot share a settlement row.
--
-- 2 and 3 are enforced by COMPOSITE foreign keys on (liquidationId, shipmentId)
-- rather than by a plain key plus a service-level check, so a row can never be
-- booked against an account belonging to a different trip. That is why
-- `shipmentId` stays on both tables instead of being reached through the
-- liquidation: the redundancy is what the database verifies.

-- ---------------------------------------------------------------------------
-- 1. Liquidation: a custodian, and more than one per trip
-- ---------------------------------------------------------------------------

ALTER TABLE "liquidation" ADD COLUMN "custodianId" TEXT;

CREATE INDEX "liquidation_custodianId_idx" ON "liquidation"("custodianId");

ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_custodianId_fkey"
  FOREIGN KEY ("custodianId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "liquidation"."custodianId" IS
  'The crew member answerable for accounting for this cash. Nullable because the trip''s first liquidation is created at booking, before anybody is assigned. NOT the same as an allowance''s recipient: a helper can be handed ferry money the driver remains answerable for.';
COMMENT ON COLUMN "liquidation"."totalAllowance" IS
  'Sum of THIS liquidation''s allowances — the releases booked against this custodian, not every release on the trip.';

DROP INDEX "liquidation_shipment_live_key";

-- One open account per person per trip. NULLS NOT DISTINCT so a shipment also
-- cannot end up with two custodian-less accounts, which would be
-- indistinguishable from each other and from a bug.
CREATE UNIQUE INDEX "liquidation_shipment_custodian_live_key"
  ON "liquidation" ("shipmentId", "custodianId") NULLS NOT DISTINCT
  WHERE "deletedAt" IS NULL;

-- The target of the composite keys below. Total, not partial: a child points at
-- a specific row, and a soft-deleted parent still has to resolve.
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_id_shipment_key" UNIQUE ("id", "shipmentId");

-- ---------------------------------------------------------------------------
-- 2. Allowance: which account the release is booked against
-- ---------------------------------------------------------------------------

ALTER TABLE "allowance" ADD COLUMN "liquidationId" TEXT;

-- Deterministic today: every shipment carrying an allowance has exactly one
-- liquidation (verified before writing this). A live one is preferred so a
-- superseded row never wins.
UPDATE "allowance" a
   SET "liquidationId" = COALESCE(
         (SELECT l.id FROM "liquidation" l
           WHERE l."shipmentId" = a."shipmentId" AND l."deletedAt" IS NULL
           ORDER BY l."createdAt" LIMIT 1),
         (SELECT l.id FROM "liquidation" l
           WHERE l."shipmentId" = a."shipmentId"
           ORDER BY l."createdAt" LIMIT 1)
       );

DO $$
DECLARE
  stranded INT;
BEGIN
  SELECT count(*) INTO stranded FROM "allowance" WHERE "liquidationId" IS NULL;

  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% allowance(s) sit on a shipment with no liquidation at all. Backfilling them would mean inventing an account for cash somebody actually holds; create the liquidations first.',
      stranded;
  END IF;
END $$;

ALTER TABLE "allowance" ALTER COLUMN "liquidationId" SET NOT NULL;

CREATE INDEX "allowance_liquidationId_idx" ON "allowance"("liquidationId");

-- COMPOSITE, on purpose. A plain FK on liquidationId alone would happily let a
-- release be booked against another trip's account; this cannot.
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_liquidationId_shipmentId_fkey"
  FOREIGN KEY ("liquidationId", "shipmentId")
  REFERENCES "liquidation"("id", "shipmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMENT ON COLUMN "allowance"."liquidationId" IS
  'Which custodian''s account this release is booked against, and therefore whose variance it moves. Composite FK with shipmentId, so it can never name an account on another trip.';

-- ---------------------------------------------------------------------------
-- 3. Settlement: one per liquidation, not per shipment
-- ---------------------------------------------------------------------------

ALTER TABLE "settlement" ADD COLUMN "liquidationId" TEXT;

UPDATE "settlement" s
   SET "liquidationId" = COALESCE(
         (SELECT l.id FROM "liquidation" l
           WHERE l."shipmentId" = s."shipmentId" AND l."deletedAt" IS NULL
           ORDER BY l."createdAt" LIMIT 1),
         (SELECT l.id FROM "liquidation" l
           WHERE l."shipmentId" = s."shipmentId"
           ORDER BY l."createdAt" LIMIT 1)
       );

DO $$
DECLARE
  stranded INT;
BEGIN
  SELECT count(*) INTO stranded FROM "settlement" WHERE "liquidationId" IS NULL;

  IF stranded > 0 THEN
    RAISE EXCEPTION
      '% settlement(s) sit on a shipment with no liquidation. A settlement records the variance of a liquidation, so there is nothing honest to attach them to.',
      stranded;
  END IF;
END $$;

ALTER TABLE "settlement" ALTER COLUMN "liquidationId" SET NOT NULL;

CREATE INDEX "settlement_liquidationId_idx" ON "settlement"("liquidationId");

ALTER TABLE "settlement" ADD CONSTRAINT "settlement_liquidationId_shipmentId_fkey"
  FOREIGN KEY ("liquidationId", "shipmentId")
  REFERENCES "liquidation"("id", "shipmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "settlement_shipment_live_key";

CREATE UNIQUE INDEX "settlement_liquidation_live_key"
  ON "settlement" ("liquidationId") WHERE "deletedAt" IS NULL;

COMMENT ON COLUMN "settlement"."liquidationId" IS
  'Whose leftover cash this is. One live settlement per liquidation, not per shipment: two custodians each holding change cannot share a row, and the blended figure the old shape produced would chase one of them for the other''s money.';
