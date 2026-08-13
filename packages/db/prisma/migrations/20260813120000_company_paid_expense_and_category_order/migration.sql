-- A trip cost the company paid itself, and a kinder default for category order.
--
-- 1. COMPANY_PAID_EXPENSE appears. The trip's P&L had a hole in it: a
--    fleet-card fuel purchase or an office-paid toll account is a real cost of
--    the trip that no crew member can liquidate, because no crew member ever
--    held the money. The two tables that could have taken it both lie —
--    liquidation_line would put a variance on a crew who were never advanced
--    it, and billable_expense would invent revenue from a client who is not
--    being charged. Gross profit cannot be computed honestly without this.
--
-- 2. EXPENSE_CATEGORY."sortOrder" defaults to 10 instead of 0. The seeded
--    categories are spaced 10 apart, so a category created without a stated
--    order was landing ahead of all of them. Existing rows are untouched: a 0
--    already stored was somebody's choice for all this migration knows.

-- ---------------------------------------------------------------------------
-- 1. company_paid_expense
-- ---------------------------------------------------------------------------

CREATE TABLE "company_paid_expense" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "expenseCategoryId" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,4) NOT NULL,
    "spentAt" TIMESTAMPTZ(6) NOT NULL,
    "receiptId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "company_paid_expense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "company_paid_expense_shipmentId_idx" ON "company_paid_expense"("shipmentId");
CREATE INDEX "company_paid_expense_expenseCategoryId_idx" ON "company_paid_expense"("expenseCategoryId");
CREATE INDEX "company_paid_expense_deletedAt_idx" ON "company_paid_expense"("deletedAt");

ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_expenseCategoryId_fkey"
  FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A receipt backs at most one live row, matching allowance, settlement,
-- liquidation_line and billable_expense. One photograph, one expense.
CREATE UNIQUE INDEX "company_paid_expense_receipt_live_key"
  ON "company_paid_expense" ("receiptId") WHERE "deletedAt" IS NULL AND "receiptId" IS NOT NULL;

-- Zero is not an expense and a negative one is a refund wearing the wrong
-- table. Same constraint as allowance and liquidation_line, for the same
-- reason: this column is summed into a figure somebody reports on.
ALTER TABLE "company_paid_expense"
  ADD CONSTRAINT "company_paid_expense_amount_positive" CHECK ("amount" > 0);

COMMENT ON COLUMN "company_paid_expense"."amount" IS
  'A cost of the trip that the company settled directly. Recognised in the P&L when recorded — unlike a liquidation line, there is no approval to wait for, because the money left before the row was typed.';
COMMENT ON COLUMN "company_paid_expense"."expenseCategoryId" IS
  'Required, unlike a billable expense''s. This row exists to be a cost in the P&L and an uncategorised cost is one nobody can report on.';
COMMENT ON COLUMN "company_paid_expense"."spentAt" IS
  'When the money left, which is not when the row was typed. Separate from createdAt for the same reason allowance.issuedAt is.';

-- The standing invariants every business table carries.
ALTER TABLE "company_paid_expense"
  ADD CONSTRAINT "company_paid_expense_created_by_required" CHECK ("createdBy" IS NOT NULL);
ALTER TABLE "company_paid_expense"
  ADD CONSTRAINT "company_paid_expense_soft_delete_consistent" CHECK (
    ("deletedAt" IS NULL AND "deletedBy" IS NULL)
    OR ("deletedAt" IS NOT NULL)
  );

-- ---------------------------------------------------------------------------
-- 2. expense_category.sortOrder: 0 -> 10
-- ---------------------------------------------------------------------------

ALTER TABLE "expense_category" ALTER COLUMN "sortOrder" SET DEFAULT 10;

COMMENT ON COLUMN "expense_category"."sortOrder" IS
  'Lower appears first on expense forms. Defaults to 10 and the seeded categories are spaced 10 apart, so an unordered category lands beside the first rather than ahead of everything, and there is room to slot one between two others without renumbering.';
