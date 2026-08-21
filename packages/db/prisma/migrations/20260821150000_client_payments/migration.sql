-- Money coming IN from the client for a trip, and what is still outstanding.
--
-- WHAT THIS FIXES. Every peso a trip earned was recorded — the freight, the
-- rebilled expenses, the extra charges — and nothing recorded whether any of it
-- had been collected. "Has SMT paid for August?" was a question the system
-- could not answer at all, so it was answered from a spreadsheet, and a trip
-- invoiced twice looked exactly like a trip invoiced once.
--
-- ONE ROW PER PAYMENT, exactly as `allowance` is one row per release. A trip is
-- rarely settled in one movement: a downpayment at booking, the balance thirty
-- days after delivery, sometimes a short payment made up later. An
-- `amountPaid` column on `shipment` would have to be overwritten by the second
-- one, leaving the first with no record it happened, no date and no reference.
--
-- WHAT IS OWED IS NOT STORED. It is `netRate + billableExpenses +
-- additionalCharges` — the same figure gross profit already calls `revenue`,
-- computed in one place so an invoice and a P&L cannot disagree. A stored
-- `amountDue` would go stale the moment a late charge was recorded, silently.
--
-- NOTHING IN THE P&L READS THIS TABLE. Revenue is recognised when the trip
-- runs; this is its collection. Counting a payment as income would book the
-- same peso twice and make a trip's profit depend on how fast the client's
-- accounts payable department moves.

-- CreateTable
CREATE TABLE "client_payment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "receivedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paymentMethod" SMALLINT NOT NULL,
    "referenceNumber" TEXT,
    "receiptId" UUID,
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "client_payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "client_payment_shipmentId_idx" ON "client_payment"("shipmentId");
-- Receivables are read by date — what came in this week, what is still out —
-- so this is the column the table is actually searched by after the trip.
CREATE INDEX "client_payment_receivedAt_idx" ON "client_payment"("receivedAt");
CREATE INDEX "client_payment_deletedAt_idx" ON "client_payment"("deletedAt");

-- AddForeignKey
--
-- The shipment key is SINGLE, not the composite `(clientId, shipmentId)` that
-- `allowance` uses against the liquidation. The redundancy pays off there
-- because an account and a release must belong to the same trip and both ids
-- are already present. Here it would freeze a trip's client the moment it took
-- a payment: `shipment.clientId` is correctable until the trip is liquidated,
-- deliberately, and a composite key would turn "this trip was filed under the
-- wrong client" into an unfixable record. The payer is read through the trip.

ALTER TABLE "client_payment" ADD CONSTRAINT "client_payment_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL, like every other receipt link in this schema. A receipt swept as an
-- orphan must not take the payment row with it — and `ReceiptsService`
-- counts this table among a receipt's references precisely so a payment's proof
-- is never mistaken for an orphan in the first place.
ALTER TABLE "client_payment" ADD CONSTRAINT "client_payment_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "client_payment" ADD CONSTRAINT "client_payment_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_payment" ADD CONSTRAINT "client_payment_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "client_payment" ADD CONSTRAINT "client_payment_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The house constraints, in the same shape as every other business table.

-- STRICTLY POSITIVE, and there is no negative half to this table. A refund and
-- a dishonoured check are both the removal of a receipt that turns out not to
-- have happened, which the soft delete records with who did it and when. A
-- signed column would make "how much has this trip collected" depend on which
-- rows somebody chose to count — the same argument that keeps
-- `allowance_amount_positive` and `settlement`'s carry rule where they are.
ALTER TABLE client_payment ADD CONSTRAINT client_payment_amount_positive
  CHECK ((amount > (0)::numeric));

ALTER TABLE client_payment ADD CONSTRAINT client_payment_created_by_required
  CHECK (("createdBy" IS NOT NULL));

ALTER TABLE client_payment ADD CONSTRAINT client_payment_soft_delete_consistent
  CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));

-- Code set: PaymentMethod (1 CASH, 2 BANK_TRANSFER, 3 EWALLET, 4 CHECK).
--
-- Code 4 is the payment INSTRUMENT, not SQL's `CHECK` keyword — the collision is
-- unfortunate and the name is the business's, so it is worth saying once here.
--
-- A SEPARATE SET FROM DisbursementMode, which stops at 3. The first three codes
-- agreeing is a convenience for whoever reads both tables side by side, not a
-- licence to substitute one for the other: code 4 exists because that is how a
-- Philippine corporate client settles a hauling invoice, and it must not become
-- a way to release a crew allowance. `code-constraints.test.ts` reads this back
-- out of the catalog and compares it against the TypeScript declaration, so
-- appending a code without widening this fails the build.
ALTER TABLE client_payment ADD CONSTRAINT client_payment_method_code_valid
  CHECK (("paymentMethod" = ANY (ARRAY[1, 2, 3, 4])));

-- NOTE WHAT IS DELIBERATELY ABSENT: no unique index on "referenceNumber". One
-- check legitimately settles two trips and carries one number on both, so a
-- unique index would refuse a true record. Repetition is reported by the
-- summary — the same call, and the same reasoning, as `allowance`.

-- Comments, so somebody reading raw SQL can decode the columns that are not
-- self-evident. The code-set comment is asserted by code-constraints.test.ts.

COMMENT ON COLUMN client_payment."paymentMethod" IS
  'Code set: PaymentMethod (1 CASH, 2 BANK_TRANSFER, 3 EWALLET, 4 CHECK). Order comes from the declared sequence in @eztruckr/types, never from the number. Distinct from DisbursementMode, which governs trip cash and has no CHECK.';
COMMENT ON COLUMN client_payment."receivedAt" IS
  'When the money reached the company, not when the row was typed. A check cleared on Friday is routinely recorded on Monday.';
COMMENT ON COLUMN client_payment."referenceNumber" IS
  'Check number, transfer reference or OR number. Optional for every method and deliberately not unique — one check can settle two trips. Duplicates are reported by the payment summary, never refused.';
COMMENT ON COLUMN client_payment."amount" IS
  'Always positive. A refund or a dishonoured check is the removal of this row, not a negative one: the soft delete already records who reversed it and when.';
