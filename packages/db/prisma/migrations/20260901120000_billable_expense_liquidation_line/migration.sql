-- WHICH CLAIM a rebill defers its cost to, not merely which account.
--
-- WHAT THIS FIXES. Naming the account said the cost would arrive somewhere on
-- it and left nobody able to say where. A rebill could point at an account that
-- never filed the expense, and the cost was then counted in NEITHER place — not
-- on the rebill, which had deferred to the account, and not on the account,
-- which had nothing on it. The trip billed the client and recorded no cost at
-- all, which reads on every screen as an unusually good margin.
--
-- Pointing at the CLAIM makes the cost a rebill defers to a row that
-- demonstrably exists, and the pairing CHECK at the bottom makes "in a
-- liquidation" and "against a claim" the same state rather than two.
--
-- THE ACCOUNT IS KEPT BESIDE THE CLAIM, redundantly on purpose, because the two
-- composite keys need it in two places at once:
--   (liquidationLineId, liquidationId) -> liquidation_line (id, liquidationId)
--       the claim is on the account this rebill names
--   (liquidationId, shipmentId)        -> liquidation (id, shipmentId)
--       the account is on the trip this rebill is on
-- Together they make "the claim is on an account on this trip" a fact the
-- database checks rather than one a service is trusted about. Reaching the
-- account through the claim instead would cost the second key its left-hand
-- side, and with it the cross-trip guarantee added a migration ago.

-- The key the first of those two constraints needs. Not a new fact — `id` is
-- already unique on its own; this states the pair so it can be referenced.
CREATE UNIQUE INDEX "liquidation_line_id_liquidation_key" ON "liquidation_line"("id", "liquidationId");

ALTER TABLE "billable_expense" ADD COLUMN "liquidationLineId" UUID;

-- BACKFILL, then a deliberate demotion for whatever it cannot resolve.
--
-- A rebill already pointing at an account is matched to a live claim on that
-- same account for the same amount. The two row_numbers keep it one-to-one in
-- both directions: no claim is rebilled twice, and no rebill takes two claims.
-- An exact amount match on the same account is a strong signal — these rows
-- were written by somebody looking at the claim they meant.
WITH candidate AS (
  SELECT
    be.id AS rebill_id,
    ll.id AS line_id,
    row_number() OVER (PARTITION BY be.id ORDER BY ll.id) AS line_rank,
    row_number() OVER (PARTITION BY ll.id ORDER BY be.id) AS rebill_rank
  FROM "billable_expense" be
  JOIN "liquidation_line" ll
    ON ll."liquidationId" = be."liquidationId"
   AND ll."deletedAt" IS NULL
   AND ll."amount" = be."amount"
  WHERE be."liquidationId" IS NOT NULL
    AND be."deletedAt" IS NULL
)
UPDATE "billable_expense" be
SET "liquidationLineId" = c.line_id
FROM candidate c
WHERE be.id = c.rebill_id
  AND c.line_rank = 1
  AND c.rebill_rank = 1;

-- WHAT COULD NOT BE MATCHED BECOMES OFFICE-PAID, which is the safe direction
-- and not a guess dressed up as one. A rebill pointing at an account with no
-- claim answering to it is exactly the broken state described above: its cost
-- is currently counted nowhere. Clearing the link moves that cost back onto the
-- rebill row, so the trip is charged for money it demonstrably spent.
--
-- The wrong call here OVERSTATES cost on a handful of rows somebody can see and
-- correct; leaving them linked understates it invisibly. Deleted rows are
-- cleared too — they must satisfy the CHECK like any other.
UPDATE "billable_expense"
SET "liquidationId" = NULL
WHERE "liquidationId" IS NOT NULL
  AND "liquidationLineId" IS NULL;

ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_liquidationLineId_liquidationId_fkey"
  FOREIGN KEY ("liquidationLineId", "liquidationId") REFERENCES "liquidation_line"("id", "liquidationId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ONE LIVE REBILL PER CLAIM. The same rule as a receipt backing at most one
-- row, for a sharper reason: two rebills against one claim invoice the client
-- twice for a cost the crew incurred once. Partial, so a removed rebill frees
-- its claim rather than blocking the corrected one that replaces it.
CREATE UNIQUE INDEX "billable_expense_liquidationLineId_key"
  ON "billable_expense"("liquidationLineId")
  WHERE "deletedAt" IS NULL;

-- "In a liquidation" and "against a claim" are one state, so the columns move
-- together or the row is refused. Without this the old half-linked shape stays
-- expressible, and the hole this migration closes reopens the first time
-- somebody writes a row by hand.
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_liquidation_line_paired"
  CHECK (("liquidationId" IS NULL) = ("liquidationLineId" IS NULL));
