-- The paperwork columns: when a trip ran, what it carried, and the reference
-- printed on the piece of paper behind each movement of money.
--
-- Five changes, one theme. Everything here exists because somebody holding a
-- physical document could not find the field to type it into:
--
--   1. `shipment.shipmentDate` — when the trip actually ran, which is not when
--      somebody booked it.
--   2. `shipment.containerNumber` — the box on the trailer, and the thing a
--      client phones up quoting.
--   3. `liquidation.referenceNumber` — the voucher an account was settled
--      under.
--   4. `billable_expense` gains the fields `company_paid_expense` already has,
--      so the two disbursement forms stop disagreeing about what an expense is.
--   5. Both expense tables gain a reference number, the same one `allowance`
--      has carried since the start.

-- 1 ------------------------------------------------------------------------
--
-- NOT NULL with a default, and backfilled from `createdAt` rather than left at
-- the migration's own clock: every existing trip was booked on the day it was
-- typed in, so `createdAt` is the honest answer for them and `now()` would
-- stamp the entire history with today.
--
-- Separate from `dispatchedAt` on purpose. Dispatch is an event the system
-- records when it happens; this is the date on the paperwork, which a trip
-- entered a week late still has to be able to state.

ALTER TABLE shipment ADD COLUMN "shipmentDate" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE shipment SET "shipmentDate" = "createdAt";

COMMENT ON COLUMN shipment."shipmentDate" IS
  'The date the trip ran, as it appears on the paperwork. Defaults to now so a booking need not state it, and is deliberately not dispatchedAt — a trip recorded after the fact still has a date of its own.';

-- 2 ------------------------------------------------------------------------
--
-- Nullable: plenty of freight is not containerised, and a required field would
-- be answered with "N/A", which looks like a container number and is not.
--
-- No index. The shipment search matches it with ILIKE '%…%', which no btree
-- index can serve, and the same is already true of origin and destination.

ALTER TABLE shipment ADD COLUMN "containerNumber" TEXT;

COMMENT ON COLUMN shipment."containerNumber" IS
  'Container or van number for containerised freight. Null when the trip is not carrying one. Searchable alongside the shipment number, origin and destination.';

-- 3 ------------------------------------------------------------------------

ALTER TABLE liquidation ADD COLUMN "referenceNumber" TEXT;

COMMENT ON COLUMN liquidation."referenceNumber" IS
  'The voucher or document number this account was settled under. Optional, and never unique — a reference is what a person wrote on a piece of paper, not an identifier this system issues.';

-- 4 ------------------------------------------------------------------------
--
-- A billable expense and a company-paid expense are the same act of spending
-- recorded from two sides — one is rebilled to the client, the other is not —
-- so the difference between their forms was an accident of which was written
-- first. `isCommissionable` stays billable-only, because only a billable
-- expense can feed the crew's commission base.
--
-- `spentAt` is NOT NULL and backfilled from `createdAt`, the same argument as
-- the shipment date above.

ALTER TABLE billable_expense ADD COLUMN "spentAt" TIMESTAMPTZ(6);

UPDATE billable_expense SET "spentAt" = "createdAt";

ALTER TABLE billable_expense ALTER COLUMN "spentAt" SET NOT NULL;

ALTER TABLE billable_expense ADD COLUMN "payeeId" UUID;
ALTER TABLE billable_expense ADD COLUMN "payeeRequired" BOOLEAN NOT NULL DEFAULT true;

-- EXISTING ROWS ARE STAMPED false BEFORE THE CHECK GOES ON, and this is the
-- one line here that must not be reordered. `payeeRequired` freezes the rule
-- that applied to the row when it was written, and no billable expense written
-- before this migration could name a payee — there was no column. Defaulting
-- them to true would assert a rule that never applied to them and the CHECK
-- would then refuse every one of them.

UPDATE billable_expense SET "payeeRequired" = false;

ALTER TABLE billable_expense ADD CONSTRAINT billable_expense_payee_required
  CHECK (((NOT "payeeRequired") OR ("payeeId" IS NOT NULL)));

ALTER TABLE billable_expense ADD CONSTRAINT "billable_expense_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "billable_expense_expenseCategoryId_idx" ON billable_expense("expenseCategoryId");
CREATE INDEX "billable_expense_payeeId_idx" ON billable_expense("payeeId");

-- The description stops being mandatory now that a category is offered beside
-- it: "Diesel · Petron Balintawak" says more than a description box repeating
-- the category name, and company_paid_expense.description has been optional
-- for the same reason since the start.

ALTER TABLE billable_expense ALTER COLUMN "description" DROP NOT NULL;

COMMENT ON COLUMN billable_expense."spentAt" IS
  'When the money left, which is not when the row was typed. Same column, same argument, as company_paid_expense.spentAt.';
COMMENT ON COLUMN billable_expense."payeeId" IS
  'Who was paid. Required exactly when payeeRequired is true, enforced by billable_expense_payee_required.';
COMMENT ON COLUMN billable_expense."payeeRequired" IS
  'Copied from the expense category when the row was written. Frozen for the same reason as liquidation_line.payeeRequired. False on every row predating the column, because no payee could have been named then.';

-- 5 ------------------------------------------------------------------------
--
-- Optional on both, like allowance.referenceNumber and for the same reason: a
-- mandatory reference is answered with an invented one, which reads like
-- evidence and is not.

ALTER TABLE billable_expense ADD COLUMN "referenceNumber" TEXT;
ALTER TABLE company_paid_expense ADD COLUMN "referenceNumber" TEXT;

COMMENT ON COLUMN billable_expense."referenceNumber" IS
  'Invoice, official receipt or transaction reference for this expense. Optional and never unique — see allowance.referenceNumber.';
COMMENT ON COLUMN company_paid_expense."referenceNumber" IS
  'Invoice, official receipt or transaction reference for this expense. Optional and never unique — see allowance.referenceNumber.';
