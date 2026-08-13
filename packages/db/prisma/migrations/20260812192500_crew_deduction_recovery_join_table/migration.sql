-- Crew deductions become recoverable across several payout runs.
--
-- THE PROBLEM. A deduction is divisible; a commission is not. A commission is
-- paid whole or not at all, so `Commission.payoutLineId` — a single link with a
-- full unique — models it exactly. A ₱9,000 damage claim against a crew member
-- earning ₱1,800 a fortnight cannot be taken in one go, so it comes back a
-- slice at a time. `CrewDeduction` was modelling that with a single
-- `payoutLineId` PLUS a `recovered` running total, which is two incompatible
-- designs at once:
--
--   * the link was repointed on every run, so all but the most recent recovery
--     disappeared and an earlier payout voucher could no longer be itemised —
--     the line's own `deductionAmount` still totalled correctly, but nothing
--     recorded WHICH debts it had covered;
--   * `recovered` was a mutable number with no record of what made it up, so
--     "how much did we recover in March?" was unanswerable;
--   * and nothing stopped it being incremented twice for the same run, which
--     recovers a debt twice and short-changes the crew member. That is the
--     mirror image of the double-payment the commission triggers prevent, and
--     this side of the ledger had no equivalent guard at all.
--
-- THE SHAPE NOW. One row per slice, in `crew_deduction_recovery`: which debt,
-- which payout line, how much. The outstanding balance is derived by summing
-- live recoveries — `recovered` and `isSettled` are dropped rather than kept as
-- a cache, for the same reason the SystemSetting commission-rate fallback was
-- dropped: two places holding one number, where the weaker one wins silently
-- when they disagree.
--
-- Safe to do destructively: crew_deduction, crew_deduction_recovery's future
-- inputs, payout_line, payout_run and adjustment are all empty (verified 0 rows
-- each), so no recovery history is being discarded.

-- ---------------------------------------------------------------------------
-- The join table
-- ---------------------------------------------------------------------------

CREATE TABLE "crew_deduction_recovery" (
    "id" TEXT NOT NULL,
    "crewDeductionId" TEXT NOT NULL,
    "payoutLineId" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "crew_deduction_recovery_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crew_deduction_recovery_crewDeductionId_idx" ON "crew_deduction_recovery"("crewDeductionId");
CREATE INDEX "crew_deduction_recovery_payoutLineId_idx" ON "crew_deduction_recovery"("payoutLineId");
CREATE INDEX "crew_deduction_recovery_deletedAt_idx" ON "crew_deduction_recovery"("deletedAt");

-- RESTRICT on both parents, like every other business foreign key here: a
-- soft-deleted parent must stay readable for history rather than cascading.
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_crewDeductionId_fkey"
  FOREIGN KEY ("crewDeductionId") REFERENCES "crew_deduction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_payoutLineId_fkey"
  FOREIGN KEY ("payoutLineId") REFERENCES "payout_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The house rules every business table carries.
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_created_by_required" CHECK ("createdBy" IS NOT NULL);
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_soft_delete_consistent" CHECK (
    ("deletedAt" IS NULL AND "deletedBy" IS NULL) OR "deletedAt" IS NOT NULL
  );

-- One payout line takes at most one slice of any given debt. Partial, so a
-- reversed (soft-deleted) recovery does not block a corrected one on the same
-- line.
CREATE UNIQUE INDEX "crew_deduction_recovery_deduction_line_live_key"
  ON "crew_deduction_recovery" ("crewDeductionId", "payoutLineId")
  WHERE "deletedAt" IS NULL;

-- A recovery moves money one way. A negative one would be a payment TO the
-- crew member, which is an Adjustment, not a recovery — and zero is not a
-- movement at all.
ALTER TABLE "crew_deduction_recovery"
  ADD CONSTRAINT "crew_deduction_recovery_amount_positive" CHECK ("amount" > 0);

COMMENT ON TABLE "crew_deduction_recovery" IS
  'One slice of a crew deduction recovered by one payout line. A deduction is divisible, unlike a commission, so recovery is a set of rows rather than a single link.';
COMMENT ON COLUMN "crew_deduction_recovery"."amount" IS
  'Money. Always positive; the sum of live rows per deduction may never exceed that deduction''s amount.';

-- ---------------------------------------------------------------------------
-- Never recover more than was owed
-- ---------------------------------------------------------------------------
--
-- A CHECK cannot express this: it spans rows. A trigger can, and it is the
-- constraint that lets `recovered` be dropped safely — the sum IS the balance,
-- so it has to be trustworthy.

CREATE OR REPLACE FUNCTION eztruckr_crew_deduction_not_over_recovered()
RETURNS TRIGGER AS $$
DECLARE
  debt      NUMERIC(15, 4);
  recovered NUMERIC(15, 4);
BEGIN
  SELECT "amount" INTO debt FROM "crew_deduction" WHERE id = NEW."crewDeductionId";

  SELECT COALESCE(SUM("amount"), 0)
    INTO recovered
    FROM "crew_deduction_recovery"
   WHERE "crewDeductionId" = NEW."crewDeductionId"
     AND "deletedAt" IS NULL;

  IF recovered > debt THEN
    RAISE EXCEPTION
      'crew deduction % would be over-recovered: % recovered against a debt of %',
      NEW."crewDeductionId", recovered, debt
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- AFTER, so the row being inserted or restored is already part of the SUM.
CREATE CONSTRAINT TRIGGER crew_deduction_recovery_not_over_recovered
AFTER INSERT OR UPDATE ON "crew_deduction_recovery"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION eztruckr_crew_deduction_not_over_recovered();

-- ---------------------------------------------------------------------------
-- Idempotency, mirroring the commission guarantees
-- ---------------------------------------------------------------------------
--
-- `eztruckr_commission_is_paid(TEXT)` already answers "is this payout line in a
-- PAID run?", which is exactly the question here too, so it is reused rather
-- than duplicated — one definition of PAID in SQL.

-- 1. A recovery in a paid run is frozen: its amount and both its links.
CREATE OR REPLACE FUNCTION eztruckr_paid_recovery_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF eztruckr_commission_is_paid(OLD."payoutLineId")
     AND (NEW."amount" IS DISTINCT FROM OLD."amount"
          OR NEW."payoutLineId" IS DISTINCT FROM OLD."payoutLineId"
          OR NEW."crewDeductionId" IS DISTINCT FROM OLD."crewDeductionId") THEN
    RAISE EXCEPTION
      'crew deduction recovery % belongs to a paid payout run and cannot be altered',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_recovery_is_immutable
BEFORE UPDATE ON "crew_deduction_recovery"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_recovery_is_immutable();

-- 2. Nor can it be soft-deleted. Reversing a recovery that has already been
--    paid out would make the debt look outstanding again and let the same
--    slice be taken from the crew member twice.
CREATE OR REPLACE FUNCTION eztruckr_paid_recovery_no_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."deletedAt" IS NULL
     AND NEW."deletedAt" IS NOT NULL
     AND eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'crew deduction recovery % has been paid and cannot be deleted; the debt would look outstanding again and could be recovered twice',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_recovery_no_soft_delete
BEFORE UPDATE ON "crew_deduction_recovery"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_recovery_no_soft_delete();

-- 3. Nor hard-deleted. Application code cannot reach a hard delete, but the
--    trigger holds for raw SQL too.
CREATE OR REPLACE FUNCTION eztruckr_paid_recovery_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'crew deduction recovery % belongs to a paid payout run and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_recovery_no_delete
BEFORE DELETE ON "crew_deduction_recovery"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_recovery_no_delete();

-- ---------------------------------------------------------------------------
-- Retire the single-link design
-- ---------------------------------------------------------------------------

DROP INDEX "crew_deduction_crewMemberId_isSettled_idx";
DROP INDEX "crew_deduction_payoutLineId_idx";

ALTER TABLE "crew_deduction" DROP CONSTRAINT "crew_deduction_payoutLineId_fkey";
ALTER TABLE "crew_deduction" DROP COLUMN "payoutLineId";
ALTER TABLE "crew_deduction" DROP COLUMN "recovered";
ALTER TABLE "crew_deduction" DROP COLUMN "isSettled";

CREATE INDEX "crew_deduction_crewMemberId_idx" ON "crew_deduction"("crewMemberId");

-- The debt itself is still a positive amount; only its recovery is divisible.
ALTER TABLE "crew_deduction"
  ADD CONSTRAINT "crew_deduction_amount_positive" CHECK ("amount" > 0);

COMMENT ON TABLE "crew_deduction" IS
  'A charge against a crew member, recovered at payout. Holds no payout link of its own: recovery is divisible across runs, so it lives in crew_deduction_recovery. Outstanding balance = amount less the sum of live recoveries.';
