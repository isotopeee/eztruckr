-- Phase 5: allowance issuance, the liquidation lifecycle, and settlement.
--
-- Four things change shape here, and each one is the same defect being fixed:
-- a column that could not say what it needed to say.
--
--   1. ALLOWANCE becomes a proper record of ONE RELEASE. It always was one row
--      per release in the schema, but with no mode, no reference, no
--      attachment and no releaser it could not document a bank transfer, so in
--      practice the second release on a trip had nowhere to go but an edit to
--      the first.
--
--   2. LIQUIDATION gains PENDING and loses FINALIZED. The row is created when
--      the shipment is delivered, so "with the crew" is a state rather than a
--      missing row, and approval is the lock rather than a step before another
--      one. `submittedAt` stops being NOT NULL DEFAULT now(), which claimed
--      every liquidation had been submitted at the moment it came into
--      existence.
--
--   3. LIQUIDATION_HISTORY appears, because returning work is not a status.
--      Both a submission and a return leave the row at a status it has held
--      before, so the status column cannot distinguish "submitted for the first
--      time" from "returned twice and resubmitted".
--
--   4. SETTLEMENT appears, one row per shipment. Whether the leftover cash came
--      back is a different question from whether the spending was accounted
--      for, and until now only the second one had a column.
--
-- The `liquidation` table is empty (verified before writing this), so nothing
-- here reinterprets a stored row.

-- ---------------------------------------------------------------------------
-- 1. Allowance: one release, fully documented
-- ---------------------------------------------------------------------------

ALTER TABLE "allowance" ADD COLUMN "disbursementMode" SMALLINT NOT NULL;
ALTER TABLE "allowance" ADD COLUMN "referenceNumber" TEXT;
ALTER TABLE "allowance" ADD COLUMN "receiptId" TEXT;
ALTER TABLE "allowance" ADD COLUMN "releasedBy" TEXT NOT NULL;

CREATE INDEX "allowance_releasedBy_idx" ON "allowance"("releasedBy");

ALTER TABLE "allowance" ADD CONSTRAINT "allowance_releasedBy_fkey"
  FOREIGN KEY ("releasedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance" ADD CONSTRAINT "allowance_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "allowance"
  ADD CONSTRAINT "allowance_disbursement_mode_code_valid"
  CHECK ("disbursementMode" IN (1, 2, 3));
COMMENT ON COLUMN "allowance"."disbursementMode" IS
  'Code set DisbursementMode (@eztruckr/types): 1 CASH, 2 BANK_TRANSFER, 3 EWALLET. How this release physically moved.';

COMMENT ON COLUMN "allowance"."releasedBy" IS
  'The user who handed over the cash. Deliberately NOT createdBy, which is whoever typed the row in — a supervisor releases in the yard and a clerk records it later, and the voucher names the first.';
COMMENT ON COLUMN "allowance"."referenceNumber" IS
  'Bank or wallet reference. Optional for every mode including transfers: a required field is answered with "N/A", which looks like evidence and is not.';

-- A release of zero is not a release, and a negative one is a settlement
-- wearing the wrong table. Neither had a constraint before Phase 5 started
-- summing this column into a variance.
ALTER TABLE "allowance"
  ADD CONSTRAINT "allowance_amount_positive" CHECK ("amount" > 0);

-- A receipt backs at most one live allowance, matching the rule already in
-- force for liquidation lines and billable expenses.
CREATE UNIQUE INDEX "allowance_receipt_live_key"
  ON "allowance" ("receiptId") WHERE "deletedAt" IS NULL AND "receiptId" IS NOT NULL;

-- Same reason, on the table that has been summing amounts since Phase 2.
ALTER TABLE "liquidation_line"
  ADD CONSTRAINT "liquidation_line_amount_positive" CHECK ("amount" > 0);

-- ---------------------------------------------------------------------------
-- 2. Route: the standard allowance that prefills the first release
-- ---------------------------------------------------------------------------

ALTER TABLE "route" ADD COLUMN "standardAllowance" DECIMAL(15,4);

ALTER TABLE "route"
  ADD CONSTRAINT "route_standard_allowance_non_negative"
  CHECK ("standardAllowance" IS NULL OR "standardAllowance" >= 0);

COMMENT ON COLUMN "route"."standardAllowance" IS
  'What the crew are normally advanced for this run. A default that prefills the first allowance and is editable there; nothing downstream reads it, and variance is never measured against it.';

-- ---------------------------------------------------------------------------
-- 3. Liquidation: PENDING in, FINALIZED out
-- ---------------------------------------------------------------------------

ALTER TABLE "liquidation" DROP CONSTRAINT "liquidation_finalizedBy_fkey";
ALTER TABLE "liquidation" DROP COLUMN "finalizedAt";
ALTER TABLE "liquidation" DROP COLUMN "finalizedBy";

ALTER TABLE "liquidation" ALTER COLUMN "status" SET DEFAULT 4;

-- `submittedAt` was NOT NULL DEFAULT now(), which asserted that a liquidation
-- had been submitted at the instant it was created. A liquidation now exists
-- from delivery, unsubmitted, and `createdAt` records that moment.
ALTER TABLE "liquidation" ALTER COLUMN "submittedAt" DROP NOT NULL;
ALTER TABLE "liquidation" ALTER COLUMN "submittedAt" DROP DEFAULT;

-- 4 PENDING is appended; 3 FINALIZED is withdrawn and never reused. Codes are
-- permanent, so the set reads 1, 2, 4 rather than being renumbered tidy — see
-- RETIRED_LIQUIDATION_STATUS_CODES in @eztruckr/types.
ALTER TABLE "liquidation" DROP CONSTRAINT "liquidation_status_code_valid";
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_status_code_valid" CHECK ("status" IN (1, 2, 4));
COMMENT ON COLUMN "liquidation"."status" IS
  'Code set LiquidationStatus (@eztruckr/types): 4 PENDING, 1 SUBMITTED, 2 APPROVED. Order comes from the declared sequence, NOT from the number — PENDING is first and highest. Code 3 (FINALIZED) is retired and must never be reused.';

-- A submitted or approved liquidation was submitted at some point; a pending
-- one may or may not have been, because a returned liquidation keeps the
-- timestamp of the submission that was returned.
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_submitted_at_matches_status" CHECK (
    "status" = 4 OR "submittedAt" IS NOT NULL
  );

-- Approval and its actor travel together, and both describe the CURRENT state:
-- reversing an approval clears them, because a row claiming an approver while
-- sitting at SUBMITTED is a lie the audit trail then has to argue with. The
-- record that it was once approved lives in `audit_log`.
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_approved_pair" CHECK (
    ("approvedAt" IS NULL) = ("approvedBy" IS NULL)
  );

ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_approved_at_matches_status" CHECK (
    ("status" = 2) = ("approvedAt" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 4. Liquidation history: append-only, one row per submission and per return
-- ---------------------------------------------------------------------------

CREATE TABLE "liquidation_history" (
    "id" TEXT NOT NULL,
    "liquidationId" TEXT NOT NULL,
    "action" SMALLINT NOT NULL,
    "actorId" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "liquidation_history_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "liquidation_history_liquidationId_occurredAt_idx"
  ON "liquidation_history"("liquidationId", "occurredAt");
CREATE INDEX "liquidation_history_actorId_idx" ON "liquidation_history"("actorId");
CREATE INDEX "liquidation_history_deletedAt_idx" ON "liquidation_history"("deletedAt");

ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_liquidationId_fkey"
  FOREIGN KEY ("liquidationId") REFERENCES "liquidation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "liquidation_history"
  ADD CONSTRAINT "liquidation_history_action_code_valid" CHECK ("action" IN (1, 2));
COMMENT ON COLUMN "liquidation_history"."action" IS
  'Code set LiquidationHistoryAction (@eztruckr/types): 1 SUBMITTED, 2 RETURNED. Both leave the liquidation at a status it has held before, which is why this table exists at all.';

-- The rule that makes a return actionable: a reason is required on a return and
-- forbidden on a submission. Expressible as a constraint precisely because the
-- action is its own column rather than being inferred from the status.
ALTER TABLE "liquidation_history"
  ADD CONSTRAINT "liquidation_history_reason_matches_action" CHECK (
    ("action" = 2) = ("reason" IS NOT NULL)
  );

COMMENT ON COLUMN "liquidation_history"."actorId" IS
  'Who submitted or returned. Separate from createdBy because the actor is the point of the row — the crew portal renders it — not an audit footnote.';

-- ---------------------------------------------------------------------------
-- 5. Settlement: one per shipment, both directions documented alike
-- ---------------------------------------------------------------------------

CREATE TABLE "settlement" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "amount" DECIMAL(15,4) NOT NULL,
    "disbursementMode" SMALLINT,
    "referenceNumber" TEXT,
    "receiptId" TEXT,
    "settledAt" TIMESTAMPTZ(6),
    "settledBy" TEXT,
    "remarks" TEXT,
    "crewDeductionId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "settlement_shipmentId_idx" ON "settlement"("shipmentId");
CREATE INDEX "settlement_status_idx" ON "settlement"("status");
CREATE INDEX "settlement_crewDeductionId_idx" ON "settlement"("crewDeductionId");
CREATE INDEX "settlement_deletedAt_idx" ON "settlement"("deletedAt");

ALTER TABLE "settlement" ADD CONSTRAINT "settlement_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_settledBy_fkey"
  FOREIGN KEY ("settledBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_crewDeductionId_fkey"
  FOREIGN KEY ("crewDeductionId") REFERENCES "crew_deduction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one live settlement per shipment. Settlement is per TRIP, not per
-- release: with an advance and two top-ups there is no honest way to say which
-- one a returned ₱800 came from.
CREATE UNIQUE INDEX "settlement_shipment_live_key"
  ON "settlement" ("shipmentId") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "settlement_receipt_live_key"
  ON "settlement" ("receiptId") WHERE "deletedAt" IS NULL AND "receiptId" IS NOT NULL;

-- One debt is carried from at most one trip, so a recovered deduction can never
-- clear two settlements.
CREATE UNIQUE INDEX "settlement_crew_deduction_live_key"
  ON "settlement" ("crewDeductionId") WHERE "deletedAt" IS NULL AND "crewDeductionId" IS NOT NULL;

ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_status_code_valid" CHECK ("status" IN (1, 2, 3));
COMMENT ON COLUMN "settlement"."status" IS
  'Code set SettlementStatus (@eztruckr/types): 1 OUTSTANDING, 2 SETTLED, 3 CARRIED_TO_PAYOUT. Read DIRECTLY by the allowances-outstanding alert; never inferred from the liquidation.';

ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_disbursement_mode_code_valid"
  CHECK ("disbursementMode" IS NULL OR "disbursementMode" IN (1, 2, 3));
COMMENT ON COLUMN "settlement"."disbursementMode" IS
  'Code set DisbursementMode (@eztruckr/types): 1 CASH, 2 BANK_TRANSFER, 3 EWALLET. Null until the money moves, and null forever on a zero variance.';

-- Settling and its actor travel together, like approval on the liquidation.
ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_settled_pair" CHECK (
    ("settledAt" IS NULL) = ("settledBy" IS NULL)
  );

ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_settled_at_matches_status" CHECK (
    ("status" = 2) = ("settledAt" IS NOT NULL)
  );

-- The movement is documented or it did not happen. A settled variance names the
-- mode the cash moved by — unless there was no cash: a zero variance has
-- nothing to move, and a balance recovered from a payout run moved as a
-- deduction against pay rather than as a disbursement. Anything not yet settled
-- has not moved at all.
--
-- This is the constraint that makes "mode optional" safe: optional means "not
-- yet" or "not as cash", never "nobody bothered".
ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_movement_matches_status" CHECK (
    CASE
      WHEN "status" = 2
        THEN ("disbursementMode" IS NOT NULL)
             = ("amount" <> 0 AND "crewDeductionId" IS NULL)
      ELSE "disbursementMode" IS NULL
    END
  );

-- Carrying to payout means recovering from pay, which only exists in one
-- direction: the crew owe the company. Money the COMPANY owes is handed over,
-- not deducted, and a payout run has nothing to recover.
--
-- Two implications rather than an equivalence, because the link OUTLIVES the
-- status: a carried settlement becomes SETTLED when its debt is recovered, and
-- it keeps pointing at the debt that settled it.
ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_carry_needs_deduction" CHECK (
    "status" <> 3 OR "crewDeductionId" IS NOT NULL
  );

ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_deduction_only_when_carried" CHECK (
    "crewDeductionId" IS NULL OR "status" IN (2, 3)
  );

ALTER TABLE "settlement"
  ADD CONSTRAINT "settlement_carry_is_a_debt" CHECK (
    "crewDeductionId" IS NULL OR "amount" > 0
  );

COMMENT ON COLUMN "settlement"."amount" IS
  'The variance, frozen from the liquidation at approval. Signed: positive = crew returns cash, negative = company reimburses crew. Never a P&L line.';
COMMENT ON COLUMN "settlement"."crewDeductionId" IS
  'The ordinary CrewDeduction that carries this balance into payout. Set only at CARRIED_TO_PAYOUT; the settlement clears when that debt is fully recovered by runs marked Paid.';

-- ---------------------------------------------------------------------------
-- 6. The two new tables join the standing invariants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY['liquidation_history', 'settlement']
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("createdBy" IS NOT NULL)',
      target_table,
      target_table || '_created_by_required'
    );

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (
         ("deletedAt" IS NULL AND "deletedBy" IS NULL)
         OR ("deletedAt" IS NOT NULL)
       )',
      target_table,
      target_table || '_soft_delete_consistent'
    );
  END LOOP;
END $$;
