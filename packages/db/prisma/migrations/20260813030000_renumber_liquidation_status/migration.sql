-- Renumber LiquidationStatus to PENDING 1, SUBMITTED 2, APPROVED 3.
--
-- The set shipped in Phase 2 as SUBMITTED 1 / APPROVED 2 / FINALIZED 3, before
-- the PENDING -> SUBMITTED -> APPROVED lifecycle was specified. Phase 5 first
-- APPENDED PENDING at 4 and retired 3, on the reasoning that codes are
-- permanent and order is never read from the number. On review the user chose
-- the natural order instead, while the only rows in existence were development
-- test data.
--
-- WHY THIS IS SAFE, AND WHY IT IS THE LAST TIME. The permanence rule exists to
-- stop a renumber silently rewriting the meaning of stored rows. This migration
-- rewrites them explicitly, in one statement, so no row is reinterpreted — and
-- it is the second and final exercise of that window. From here the set is
-- append-only.
--
-- ORDER MATTERS BELOW. Three CHECK constraints encode status codes, and the
-- remapping transiently produces values two of them reject, so all three come
-- off first and go back on afterwards.

-- ---------------------------------------------------------------------------
-- 1. Constraints off
-- ---------------------------------------------------------------------------

ALTER TABLE "liquidation" DROP CONSTRAINT "liquidation_status_code_valid";
ALTER TABLE "liquidation" DROP CONSTRAINT "liquidation_submitted_at_matches_status";
ALTER TABLE "liquidation" DROP CONSTRAINT "liquidation_approved_at_matches_status";

-- ---------------------------------------------------------------------------
-- 2. Remap, in a single statement
-- ---------------------------------------------------------------------------
--
-- One UPDATE with a CASE over the OLD value. Sequential statements would
-- collide: `SET status = 2 WHERE status = 1` followed by
-- `SET status = 3 WHERE status = 2` moves the first batch twice.
--
--   4 PENDING   -> 1
--   1 SUBMITTED -> 2
--   2 APPROVED  -> 3
--
-- Code 3 held FINALIZED, which no row ever carried and which this migration
-- therefore does not have to map anywhere. The ELSE is a deliberate landmine:
-- any unexpected value fails the CHECK re-added below rather than being
-- quietly carried forward.

UPDATE "liquidation"
   SET "status" = CASE "status"
                    WHEN 4 THEN 1
                    WHEN 1 THEN 2
                    WHEN 2 THEN 3
                    ELSE "status"
                  END;

ALTER TABLE "liquidation" ALTER COLUMN "status" SET DEFAULT 1;

-- ---------------------------------------------------------------------------
-- 3. Constraints back on, against the new codes
-- ---------------------------------------------------------------------------

ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_status_code_valid" CHECK ("status" IN (1, 2, 3));

COMMENT ON COLUMN "liquidation"."status" IS
  'Code set LiquidationStatus (@eztruckr/types): 1 PENDING, 2 SUBMITTED, 3 APPROVED. Order comes from the declared sequence, not from the number. Renumbered once in Phase 5, with stored rows remapped; append-only from here.';

-- A submitted or approved liquidation was submitted at some point; a pending
-- one may or may not have been, because a returned liquidation keeps the
-- timestamp of the submission that was returned.
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_submitted_at_matches_status" CHECK (
    "status" = 1 OR "submittedAt" IS NOT NULL
  );

-- Approval and its actor describe the CURRENT state: reversing an approval
-- clears them, because a row claiming an approver while sitting at SUBMITTED is
-- a lie the audit trail then has to argue with. That it WAS approved lives in
-- `audit_log`.
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_approved_at_matches_status" CHECK (
    ("status" = 3) = ("approvedAt" IS NOT NULL)
  );
