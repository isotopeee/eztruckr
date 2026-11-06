-- A dispatcher may add a billable expense or an additional charge; accounting
-- approves it.
--
-- The same three states as client_payment, on the same code set, with one
-- difference that is the point: an UNVERIFIED or RETURNED charge counts toward
-- NOTHING. Only VERIFIED rows reach the client's amount due, the commission
-- base, gross profit and the P&L.
--
-- Every existing row was written by accounting or an administrator, so every
-- existing row is VERIFIED, stamped to whoever created it (which may be null
-- for rows written outside a request).

-- billable_expense --------------------------------------------------------

ALTER TABLE "billable_expense"
  ADD COLUMN "verificationStatus" SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN "verifiedBy" UUID,
  ADD COLUMN "verifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN "verificationNote" TEXT;

UPDATE "billable_expense" SET "verifiedBy" = "createdBy", "verifiedAt" = "createdAt";

CREATE INDEX "billable_expense_verificationStatus_idx" ON "billable_expense"("verificationStatus");

ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_verifiedBy_fkey"
  FOREIGN KEY ("verifiedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE billable_expense ADD CONSTRAINT billable_expense_verification_status_code_valid
  CHECK (("verificationStatus" = ANY (ARRAY[1, 2, 3])));

-- Looser than client_payment's on VERIFIED only: a row that predates approval
-- has no stamp to give it. UNVERIFIED and RETURNED are held exactly.
ALTER TABLE billable_expense ADD CONSTRAINT billable_expense_verification_matches_status
  CHECK (
    CASE "verificationStatus"
      WHEN 1 THEN ("verifiedBy" IS NULL AND "verifiedAt" IS NULL AND "verificationNote" IS NULL)
      WHEN 2 THEN ("verificationNote" IS NULL)
      WHEN 3 THEN ("verifiedBy" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationNote" IS NOT NULL)
      ELSE false
    END
  );

COMMENT ON COLUMN billable_expense."verificationStatus" IS
  'Code set: PaymentVerificationStatus (1 UNVERIFIED, 2 VERIFIED, 3 RETURNED). Only VERIFIED counts toward the amount due, the commission base, gross profit and the P&L. A dispatcher''s entry arrives UNVERIFIED; accounting''s is VERIFIED on the spot.';

-- additional_charge -------------------------------------------------------

ALTER TABLE "additional_charge"
  ADD COLUMN "verificationStatus" SMALLINT NOT NULL DEFAULT 2,
  ADD COLUMN "verifiedBy" UUID,
  ADD COLUMN "verifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN "verificationNote" TEXT;

UPDATE "additional_charge" SET "verifiedBy" = "createdBy", "verifiedAt" = "createdAt";

CREATE INDEX "additional_charge_verificationStatus_idx" ON "additional_charge"("verificationStatus");

ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_verifiedBy_fkey"
  FOREIGN KEY ("verifiedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE additional_charge ADD CONSTRAINT additional_charge_verification_status_code_valid
  CHECK (("verificationStatus" = ANY (ARRAY[1, 2, 3])));

-- Looser than client_payment's on VERIFIED only: a row that predates approval
-- has no stamp to give it. UNVERIFIED and RETURNED are held exactly.
ALTER TABLE additional_charge ADD CONSTRAINT additional_charge_verification_matches_status
  CHECK (
    CASE "verificationStatus"
      WHEN 1 THEN ("verifiedBy" IS NULL AND "verifiedAt" IS NULL AND "verificationNote" IS NULL)
      WHEN 2 THEN ("verificationNote" IS NULL)
      WHEN 3 THEN ("verifiedBy" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationNote" IS NOT NULL)
      ELSE false
    END
  );

COMMENT ON COLUMN additional_charge."verificationStatus" IS
  'Code set: PaymentVerificationStatus (1 UNVERIFIED, 2 VERIFIED, 3 RETURNED). Only VERIFIED counts toward the amount due, the commission base, gross profit and the P&L. A dispatcher''s entry arrives UNVERIFIED; accounting''s is VERIFIED on the spot.';
