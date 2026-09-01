-- WHICH SIDE PAID for a rebill, recorded rather than assumed.
--
-- WHAT THIS FIXES. A `billable_expense` is a cost the company recovers from the
-- client, and until now the table said nothing about whose money went out. Two
-- genuinely different things were being stored in one shape:
--
--   THE OFFICE PAID IT — a permit bought on the company card. This row is the
--   whole record of the disbursement; no other table has it.
--
--   THE CREW PAID IT — a permit bought out of the cash they are holding. The
--   cost arrives as a `liquidation_line`, where it is counted like every other
--   thing the crew spent, and this row exists only to rebill it.
--
-- Gross profit could not tell them apart, so whichever rule it picked was wrong
-- half the time: counting every rebill as cost charged the crew-paid ones twice
-- — once on the line, once here — and counting none of them let the
-- office-paid ones through as free money. The column is what makes the question
-- answerable per row instead of guessed per table.
--
-- NULL IS THE OFFICE, and that is the safe default for every row that already
-- exists. A rebill written before this column existed was recorded by the
-- office against a trip whose crew liquidated separately, so reading it as
-- company-paid states what those rows already meant. It is also the reading
-- that cannot lose a cost: the wrong guess here overstates cost on a trip
-- somebody will query, where the opposite silently overstates profit.
--
-- COMPOSITE FOREIGN KEY, exactly as `allowance` links to the same table. A
-- rebill on shipment A must not be pinned to an account on shipment B, and
-- (liquidationId, shipmentId) referencing `liquidation (id, shipmentId)` makes
-- that structural rather than something a service is trusted to check. Both
-- columns are already on the row, so the key costs nothing to state.
--
-- The key is MATCH SIMPLE, the default, which is the behaviour wanted here: a
-- NULL `liquidationId` leaves the pair unchecked, so an office-paid rebill has
-- no account to point at and is not asked for one.
ALTER TABLE "billable_expense" ADD COLUMN "liquidationId" UUID;

-- The P&L reads this table by shipment and splits on the link; the liquidation
-- screens read it the other way, to show what a custodian's account is
-- rebilling. Only the second needs an index of its own.
CREATE INDEX "billable_expense_liquidationId_idx" ON "billable_expense"("liquidationId");

ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_liquidationId_shipmentId_fkey"
  FOREIGN KEY ("liquidationId", "shipmentId") REFERENCES "liquidation"("id", "shipmentId")
  ON DELETE RESTRICT ON UPDATE CASCADE;
