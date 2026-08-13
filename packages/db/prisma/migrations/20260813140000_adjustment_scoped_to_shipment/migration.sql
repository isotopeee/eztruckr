-- Crew commission adjustments: an increase or decrease, with a reason.
--
-- The `adjustment` table has existed since Phase 2 with no code behind it. It
-- was already the right shape for a standing adjustment against a person, and
-- wrong for the case somebody actually asks for — "give the driver ₱500 more
-- for THAT trip" — because it had nowhere to say which trip.
--
-- WHY `shipmentId` AND NOT `commissionId`. Recomputing a shipment soft-deletes
-- its commissions and writes new ones, so a link to a commission row would
-- dangle every time a late charge was recorded: the adjustment would quietly
-- detach from the pay it was adjusting, and nothing would report it. A trip
-- and a crew member both survive recomputation.
--
-- The table is empty (verified before writing this), so the two CHECKs added
-- below reinterpret nothing.

ALTER TABLE "adjustment" ADD COLUMN "shipmentId" TEXT;

CREATE INDEX "adjustment_shipmentId_idx" ON "adjustment"("shipmentId");

ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The DIRECTION carries the sign, so the amount is a positive magnitude. Without
-- this, a decrease could be written twice over — direction DECREASE with a
-- negative amount — and every sum over the column would be quietly wrong in a
-- way no reader could spot from the row.
ALTER TABLE "adjustment"
  ADD CONSTRAINT "adjustment_amount_positive" CHECK ("amount" > 0);

-- NOT NULL was never the rule anybody meant. An adjustment recorded with a
-- reason of "" is an unexplained change to somebody's pay wearing the shape of
-- a documented one, and it is indistinguishable from an error when they query
-- it months later.
ALTER TABLE "adjustment"
  ADD CONSTRAINT "adjustment_reason_not_blank" CHECK (length(btrim("reason")) > 0);

COMMENT ON COLUMN "adjustment"."shipmentId" IS
  'The trip this adjusts pay for, or NULL for a standing adjustment against the crew member. Deliberately not a commission id: recomputation soft-deletes and recreates commissions, so that link would dangle.';
COMMENT ON COLUMN "adjustment"."direction" IS
  'Code set AdjustmentDirection (@eztruckr/types): 1 INCREASE, 2 DECREASE. Carries the sign; amount is always positive.';
COMMENT ON COLUMN "adjustment"."amount" IS
  'A positive magnitude. Never an edit to Commission.amount — that row is self-verifying (base x rate = amount) and an adjustment written into it would break the property that makes a payout defensible.';
COMMENT ON COLUMN "adjustment"."reason" IS
  'Required and non-blank. The whole point of the record: an unexplained change to somebody''s pay cannot be told apart from a mistake.';
COMMENT ON COLUMN "adjustment"."payoutLineId" IS
  'Set when a payout run picks this up, and the lock: a paid adjustment can no longer be edited or removed, exactly as a paid commission cannot.';
