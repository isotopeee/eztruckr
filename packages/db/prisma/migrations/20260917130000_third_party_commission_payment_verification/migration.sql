-- A dispatch manager may record that the broker was paid; accounting checks it.
--
-- The same four-state control as client_payment, on the same code set: an
-- accountant's own entry is VERIFIED on the spot, anybody else's is UNVERIFIED
-- until accounting verifies it or returns it with a reason. A RETURNED payment
-- is not deducted from the client's balance; an UNVERIFIED one is, exactly as
-- an unverified client payment counts as collected.

ALTER TABLE "shipment"
  ADD COLUMN "tpcVerificationStatus" SMALLINT,
  ADD COLUMN "tpcVerifiedBy" UUID,
  ADD COLUMN "tpcVerifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN "tpcVerificationNote" TEXT;

-- Payments marked before this migration were marked by accounting or an
-- administrator (the only roles allowed until now), so they are verified. The
-- original marker is not recorded on the row; "updatedBy" is the closest fact.
UPDATE "shipment"
SET "tpcVerificationStatus" = 2,
    "tpcVerifiedBy" = COALESCE("updatedBy", "createdBy"),
    "tpcVerifiedAt" = "updatedAt"
WHERE "tpcPaidAt" IS NOT NULL;

ALTER TABLE "shipment" ADD CONSTRAINT "shipment_tpcVerifiedBy_fkey"
  FOREIGN KEY ("tpcVerifiedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "shipment" ADD CONSTRAINT shipment_tpc_verification_status_code_valid
  CHECK (("tpcVerificationStatus" = ANY (ARRAY[1, 2, 3])));

-- Unpaid carries no verification at all; paid carries a status, and the status
-- decides the rest — the same combination client_payment enforces.
ALTER TABLE "shipment" ADD CONSTRAINT shipment_tpc_verification_matches_status
  CHECK (
    CASE
      WHEN "tpcPaidAt" IS NULL THEN ("tpcVerificationStatus" IS NULL
        AND "tpcVerifiedBy" IS NULL AND "tpcVerifiedAt" IS NULL AND "tpcVerificationNote" IS NULL)
      WHEN "tpcVerificationStatus" = 1 THEN ("tpcVerifiedBy" IS NULL
        AND "tpcVerifiedAt" IS NULL AND "tpcVerificationNote" IS NULL)
      WHEN "tpcVerificationStatus" = 2 THEN ("tpcVerifiedBy" IS NOT NULL
        AND "tpcVerifiedAt" IS NOT NULL AND "tpcVerificationNote" IS NULL)
      WHEN "tpcVerificationStatus" = 3 THEN ("tpcVerifiedBy" IS NOT NULL
        AND "tpcVerifiedAt" IS NOT NULL AND "tpcVerificationNote" IS NOT NULL)
      ELSE false
    END
  );

COMMENT ON COLUMN "shipment"."tpcVerificationStatus" IS
  'Code set: PaymentVerificationStatus (1 UNVERIFIED, 2 VERIFIED, 3 RETURNED). Order comes from the declared sequence in @eztruckr/types, never from the number. Null while the cut is unpaid. RETURNED is not deducted from the client balance.';
COMMENT ON COLUMN "shipment"."tpcVerificationNote" IS
  'Why accounting returned the third-party payment. Required on a return and forbidden otherwise, by shipment_tpc_verification_matches_status.';
