-- MANY ACCOUNTS PER CUSTODIAN, and the number that tells them apart.
--
-- WHAT THIS FIXES. `liquidation_shipment_custodian_live_key` allowed one live
-- account per person per trip, and that was the same blending defect the
-- custodian was introduced to remove, one level down. A driver drawing a second
-- advance halfway through a long haul is holding two piles of cash against two
-- vouchers: the office issues them separately, counts them separately and
-- squares them up separately. One row for both meant
--
--   the first advance could not be approved until the second had been spent,
--   because approval freezes the account and the account was still taking
--   releases;
--
--   one `variance` stood where the paperwork has two, so a driver who returned
--   the change from the first voucher still read as owing it until the second
--   was liquidated;
--
--   and one `referenceNumber` had to name two vouchers.
--
-- The custodian stays exactly what it was — the person answerable — and stops
-- being the account's IDENTITY, which is what it was quietly doing.
--
-- `sequence` IS THAT IDENTITY. "Juan Dela Cruz's liquidation" stopped naming
-- one thing the moment he could hold two, and every refusal, settlement and
-- outstanding-cash alert in the system names an account by its custodian. The
-- number is allocated max + 1 over the trip's accounts INCLUDING soft-deleted
-- ones and is never reused: an account removed as a mistake would otherwise
-- hand its number on, and "account 2" in a message written last week would
-- start pointing at a different pile of cash. That is why the unique index
-- below is NOT partial on `deletedAt` — the one place in this schema where a
-- live-only index would be the wrong shape.
--
-- Existing rows are numbered in creation order, which is the order the screens
-- already list them in, so nothing that anybody has looked at is renumbered.
ALTER TABLE "liquidation" ADD COLUMN "sequence" INTEGER;

UPDATE "liquidation" AS l
SET "sequence" = numbered.ord
FROM (
  SELECT id, row_number() OVER (PARTITION BY "shipmentId" ORDER BY "createdAt", id) AS ord
  FROM "liquidation"
) AS numbered
WHERE l.id = numbered.id;

ALTER TABLE "liquidation" ALTER COLUMN "sequence" SET NOT NULL;

CREATE UNIQUE INDEX "liquidation_shipment_sequence_key" ON "liquidation"("shipmentId", "sequence");

-- One account per person per trip: gone, deliberately.
DROP INDEX liquidation_shipment_custodian_live_key;

-- WHAT SURVIVES OF IT, and only this: at most one LIVE account with nobody
-- named to it. Two unnamed accounts on one trip are indistinguishable from each
-- other — a release booked against "the unassigned account" would have no way
-- to say which — and the row exists for exactly one case, the account created
-- at booking before anybody is assigned to drive. Naming a custodian is what
-- makes room for the next one.
--
-- NULLS NOT DISTINCT is gone with it: the index no longer compares custodians
-- at all, it counts the unnamed ones.
CREATE UNIQUE INDEX liquidation_shipment_unnamed_live_key
  ON public.liquidation USING btree ("shipmentId")
  WHERE ("deletedAt" IS NULL AND "custodianId" IS NULL);

COMMENT ON COLUMN liquidation."sequence" IS
  'This account''s number on its trip — 1, 2, 3 — and the only thing that tells two accounts of the same custodian apart. Allocated max + 1 over the trip''s accounts including soft-deleted ones, so a number is never reused and a message naming "account 2" means the same account a year later. Distinct from referenceNumber, which is what somebody wrote on a voucher: this is the number the system issues.';

COMMENT ON COLUMN liquidation."custodianId" IS
  'The staff member answerable for accounting for this cash. Nullable because the trip''s first liquidation is created at booking, before anybody is assigned. NOT the same as an allowance''s recipient: a helper can be handed ferry money the driver remains answerable for. Not necessarily on the truck either — a dispatch manager holds a trip''s float without driving or helping. Not unique on the trip: one person may hold several accounts on one trip, successive advances against successive vouchers, and `sequence` is what tells those apart. Only the UNNAMED account is limited to one live row per trip.';
