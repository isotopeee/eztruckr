-- Running costs of the BUSINESS, belonging to no trip.
--
-- WHAT THIS FIXES. Every peso a trip cost was recorded — what the crew spent,
-- what the company paid on its behalf, what was rebilled — and nothing recorded
-- what it cost to keep the company open. Office rent, electricity, the
-- accountant's retainer, comprehensive insurance, an LTO renewal, a workshop
-- invoice for a truck sitting idle between jobs: all of it lived in a
-- spreadsheet, so "what did we actually make in August" could be answered per
-- trip and not for the business.
--
-- WHY NOT A NULLABLE "shipmentId" ON company_paid_expense, which is the change
-- this looks like. That column is what every per-trip cost read joins on.
-- Making it nullable would mean a trip's margin depended on a WHERE clause
-- rather than on which table a row is in — the first `findMany({ where: {
-- shipmentId } })` written without thinking would put the office rent in a
-- shipment's costs — and `shipment`'s own removal cascade, which soft-deletes
-- its children by "shipmentId", would have no meaning for the null rows.
-- One column, one job.
--
-- NOTHING IN A TRIP'S P&L READS THIS TABLE, and nothing should start. Gross
-- profit is per shipment, and overhead is by definition not attributable to
-- one; apportioning it across trips would invent a number. This answers the
-- company-wide question instead: what did running the business cost, and on
-- what.
--
-- IT CLASSIFIES AGAINST THE SAME expense_category AS THE TRIP-LEVEL COSTS. A
-- second category table would let "Fuel" mean two different things depending on
-- which screen typed it, and any report spanning both would have to reconcile
-- them.

-- CreateTable
CREATE TABLE "operation_expense" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "expenseCategoryId" UUID NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,4) NOT NULL,
    "spentAt" TIMESTAMPTZ(6) NOT NULL,
    "payeeId" UUID,
    "payeeRequired" BOOLEAN NOT NULL DEFAULT true,
    "referenceNumber" TEXT,
    "receiptId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "operation_expense_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
--
-- "spentAt" LEADS, unlike every trip-scoped cost table, where "shipmentId"
-- does. There is no trip to narrow by here: this ledger is always read as a
-- period — a month, a quarter, a year to date — so the date is the column it is
-- actually searched by rather than a secondary filter.
CREATE INDEX "operation_expense_spentAt_idx" ON "operation_expense"("spentAt");
CREATE INDEX "operation_expense_expenseCategoryId_idx" ON "operation_expense"("expenseCategoryId");
CREATE INDEX "operation_expense_payeeId_idx" ON "operation_expense"("payeeId");
CREATE INDEX "operation_expense_deletedAt_idx" ON "operation_expense"("deletedAt");

-- AddForeignKey

-- RESTRICT, like every other reference to a category. A category somebody has
-- filed overhead against is now part of what those rows say, and
-- `ExpenseCategoriesService` probes this table so the removal deactivates
-- rather than reaching the database as a delete that fails here.
ALTER TABLE "operation_expense" ADD CONSTRAINT "operation_expense_expenseCategoryId_fkey"
  FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operation_expense" ADD CONSTRAINT "operation_expense_payeeId_fkey"
  FOREIGN KEY ("payeeId") REFERENCES "payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- SET NULL, like every other receipt link in this schema. A receipt swept as an
-- orphan must not take the expense row with it — and `ReceiptsService` counts
-- this table among a receipt's references precisely so an overhead invoice is
-- never mistaken for an orphan in the first place.
ALTER TABLE "operation_expense" ADD CONSTRAINT "operation_expense_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "operation_expense" ADD CONSTRAINT "operation_expense_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operation_expense" ADD CONSTRAINT "operation_expense_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "operation_expense" ADD CONSTRAINT "operation_expense_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The house constraints, in the same shape as every other business table.

-- STRICTLY POSITIVE, and there is no negative half to this table. A supplier
-- credit note or an expense recorded twice is the removal of the row, which the
-- soft delete records with who did it and when — the same call as
-- `company_paid_expense_amount_positive` and `client_payment_amount_positive`.
-- A signed column would make "what did we spend in August" a figure that
-- depends on which rows somebody chose to count.
ALTER TABLE operation_expense ADD CONSTRAINT operation_expense_amount_positive
  CHECK ((amount > (0)::numeric));

ALTER TABLE operation_expense ADD CONSTRAINT operation_expense_created_by_required
  CHECK (("createdBy" IS NOT NULL));

-- The frozen flag paired with the column it governs, exactly as
-- `company_paid_expense_payee_required` and `liquidation_line_payee_required`
-- do. The service resolves the requirement from the category and copies it onto
-- the row; this is what makes the database refuse the same rows the service
-- does, rather than trusting the service to have been called.
ALTER TABLE operation_expense ADD CONSTRAINT operation_expense_payee_required
  CHECK (((NOT "payeeRequired") OR ("payeeId" IS NOT NULL)));

ALTER TABLE operation_expense ADD CONSTRAINT operation_expense_soft_delete_consistent
  CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));

-- A receipt backs at most one LIVE row, the same partial unique every other
-- attachment carries. Partial on "deletedAt" so removing an expense releases
-- its receipt for re-use rather than burning the slot forever.
CREATE UNIQUE INDEX operation_expense_receipt_live_key
  ON public.operation_expense USING btree ("receiptId")
  WHERE (("deletedAt" IS NULL) AND ("receiptId" IS NOT NULL));

-- NOTE WHAT IS DELIBERATELY ABSENT.
--
-- No "shipmentId", nullable or otherwise — see the header.
--
-- No status column. The money left before the row was typed, so there is
-- nothing to wait for; a status here would only pretend otherwise. This is the
-- same call `company_paid_expense` makes and the opposite of
-- `liquidation_line`, whose cost is the crew's claim until it is approved.
--
-- No lock, and no "period" column to lock against. A trip's costs freeze when
-- the trip CLOSES; this has no trip, and the system has no accounting period to
-- close instead. Inventing a freeze here would be a rule with no event behind
-- it. When a period close does exist, this is the table that wants it.

-- Comments, so somebody reading raw SQL can decode the columns that are not
-- self-evident.

COMMENT ON COLUMN operation_expense.amount IS
  'A running cost of the business that no trip caused. Always positive: a credit note or a double entry is the removal of this row, not a negative one. Recognised when recorded — the money left before the row was typed.';
COMMENT ON COLUMN operation_expense."expenseCategoryId" IS
  'Required, and the same expense_category the trip-level costs classify against, so a category means one thing across both.';
COMMENT ON COLUMN operation_expense."spentAt" IS
  'When the money left, which is not when the row was typed. This ledger is read by period, so this is the column it is indexed and searched on.';
COMMENT ON COLUMN operation_expense."payeeId" IS
  'Who the company paid. Required exactly when payeeRequired is true, enforced by operation_expense_payee_required.';
COMMENT ON COLUMN operation_expense."payeeRequired" IS
  'Copied from the expense category when the row was written. Frozen for the same reason as liquidation_line.payeeRequired.';
COMMENT ON COLUMN operation_expense."referenceNumber" IS
  'Invoice, official receipt or transaction reference. Optional and deliberately not unique — one supplier invoice legitimately covers several months.';
