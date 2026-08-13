-- Record which commission rule produced each commission.
--
-- Until now a commission froze its rate, method, and (for a formula) the
-- expression and field values — everything needed to CHECK the figure, but not
-- enough to answer "which rule paid this?" except by inference from the frozen
-- rate and method. With several rules able to carry the same rate at different
-- scopes, that inference is ambiguous exactly when someone is disputing a
-- payout.
--
-- WHY TWO COLUMNS. The id traces; the name reads. Following the id gives you
-- the rule as it stands TODAY, which is the very thing every other applied*
-- column exists to avoid — a rule renamed from "Northport 2026 driver" to
-- "Northport 2027 driver" would silently relabel last year's vouchers. So the
-- name is frozen alongside, for the same reason appliedFormulaExpression is.

ALTER TABLE "commission" ADD COLUMN "appliedRuleId" TEXT;
ALTER TABLE "commission" ADD COLUMN "appliedRuleName" TEXT;

CREATE INDEX "commission_appliedRuleId_idx" ON "commission"("appliedRuleId");

-- RESTRICT, like every business foreign key here. A rule that has paid money
-- is deactivated rather than removed (the removal probe added alongside this
-- migration counts commissions), so the trail stays walkable. Soft-deleting a
-- rule leaves this link intact and readable: to-one relations are deliberately
-- not filtered by the soft-delete extension, precisely so history resolves.
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_appliedRuleId_fkey"
  FOREIGN KEY ("appliedRuleId") REFERENCES "commission_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The two travel together or not at all. A name with no id cannot be traced; an
-- id with no name defeats the point of freezing it.
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_applied_rule_id_and_name_together" CHECK (
    ("appliedRuleId" IS NULL) = ("appliedRuleName" IS NULL)
  );

-- DELIBERATELY NOT BACKFILLED. Resolution depends on the rules and dates as
-- they stood at computation; re-running it today against rules that may since
-- have changed would produce a confident wrong answer on exactly the rows an
-- auditor would trust. Null here means "computed before this column existed",
-- which is honest. Every commission computed from now on carries both.

COMMENT ON COLUMN "commission"."appliedRuleId" IS
  'The CommissionRule that produced this commission. Null only on rows computed before this column existed — never backfilled, because resolution depends on rules and dates as they were.';
COMMENT ON COLUMN "commission"."appliedRuleName" IS
  'The rule name as it read at computation, frozen so a later rename cannot relabel an old voucher. Always set together with appliedRuleId.';
