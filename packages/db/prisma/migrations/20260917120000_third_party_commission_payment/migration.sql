-- Paying the broker their cut, recorded on the trip it was earned on.
--
-- COLUMNS ON "shipment", NOT A TABLE. A trip owes one broker one cut, agreed
-- in the rate chain beside these columns, and it is settled once. A child table
-- would allow a second row nobody can explain.
--
-- "tpcPaidAt" IS THE FLAG. Null means unpaid; a date means paid on that date.
-- A separate boolean would be a second column free to disagree with the date.

ALTER TABLE "shipment"
  ADD COLUMN "tpcPaidAt" TIMESTAMPTZ(6),
  ADD COLUMN "tpcPaymentMethod" SMALLINT,
  ADD COLUMN "tpcReferenceNumber" TEXT,
  ADD COLUMN "tpcPaymentRemarks" TEXT;

-- The same code set as client_payment."paymentMethod". Listed in
-- code-constraints.test.ts, so appending a code without widening this fails
-- the build.
ALTER TABLE "shipment" ADD CONSTRAINT shipment_tpc_payment_method_code_valid
  CHECK (("tpcPaymentMethod" = ANY (ARRAY[1, 2, 3, 4])));

-- A payment has a method, and the details belong to a payment. Unmarking clears
-- all four together.
ALTER TABLE "shipment" ADD CONSTRAINT shipment_tpc_payment_complete
  CHECK (
    ("tpcPaidAt" IS NULL AND "tpcPaymentMethod" IS NULL
      AND "tpcReferenceNumber" IS NULL AND "tpcPaymentRemarks" IS NULL)
    OR ("tpcPaidAt" IS NOT NULL AND "tpcPaymentMethod" IS NOT NULL)
  );

COMMENT ON COLUMN "shipment"."tpcPaidAt" IS
  'When the third-party commission was paid. Null means unpaid. When set, "tpcAmount" is deducted from the client balance.';
COMMENT ON COLUMN "shipment"."tpcPaymentMethod" IS
  'Code set: PaymentMethod (1 CASH, 2 BANK_TRANSFER, 3 EWALLET, 4 CHECK). Order comes from the declared sequence in @eztruckr/types, never from the number.';
