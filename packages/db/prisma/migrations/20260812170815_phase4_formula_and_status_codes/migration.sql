-- Phase 4: the FORMULA commission method, and the shipment status codes the
-- brief always specified.
--
-- Two code-set corrections here deserve their reasoning recorded, because both
-- touch the "codes are permanent, append only" rule.
--
--   ShipmentStatus. PENDING_LIQUIDATION was specified from the start and was
--   omitted in Phase 2, which left LIQUIDATED on 5 and CLOSED on 6. They move
--   to 6 and 7 so that PENDING_LIQUIDATION can take 5. That rule exists to stop
--   a renumber silently rewriting the meaning of stored rows; `shipment` was
--   empty when this ran (verified: 0 rows), so nothing was reinterpreted. The
--   rule is back in force from here.
--
--   CommissionMethod 5. Held a `TIERED` method no specification asked for —
--   a leftover from the tiered-rates feature that was implemented and then
--   fully reverted. Reserved, unimplemented, referenced by no row (verified:
--   every commission_rule row is method 1). It becomes FORMULA, the method
--   the brief always named at code 5. Only the meaning of an unused code
--   changed, so no data was reinterpreted here either.

-- AlterTable
ALTER TABLE "commission" ADD COLUMN     "appliedFormulaExpression" TEXT,
ADD COLUMN     "appliedFormulaFields" JSONB,
ALTER COLUMN "appliedRate" DROP NOT NULL,
ALTER COLUMN "appliedRate" SET DATA TYPE DECIMAL(9,4);

-- AlterTable
ALTER TABLE "commission_rule" ADD COLUMN     "params" JSONB;

-- ---------------------------------------------------------------------------
-- ShipmentStatus gains PENDING_LIQUIDATION
-- ---------------------------------------------------------------------------

ALTER TABLE "shipment" DROP CONSTRAINT "shipment_status_code_valid";
ALTER TABLE "shipment"
  ADD CONSTRAINT "shipment_status_code_valid" CHECK ("status" IN (1, 2, 3, 4, 5, 6, 7));
COMMENT ON COLUMN "shipment"."status" IS
  'Code set ShipmentStatus (@eztruckr/types): 1 DRAFT, 2 DISPATCHED, 3 IN_TRANSIT, 4 DELIVERED, 5 PENDING_LIQUIDATION, 6 LIQUIDATED, 7 CLOSED. Workflow order comes from the declared sequence in @eztruckr/types, never from the numeric value. DELIVERED is written through to PENDING_LIQUIDATION in the same statement, so a delivered trip is never left looking un-acted-on.';

-- ---------------------------------------------------------------------------
-- CommissionMethod code 5 is FORMULA
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "commission_rule"."method" IS
  'Code set CommissionMethod (@eztruckr/types): 1 PERCENT_OF_BASE, 2 FIXED_PER_TRIP, 3 FIXED_PER_ROUTE, 4 PERCENT_OF_NET_RATE, 5 FORMULA.';
COMMENT ON COLUMN "commission"."appliedMethod" IS
  'Code set CommissionMethod (@eztruckr/types): 1 PERCENT_OF_BASE, 2 FIXED_PER_TRIP, 3 FIXED_PER_ROUTE, 4 PERCENT_OF_NET_RATE, 5 FORMULA. Frozen at computation so the row stays interpretable if the rule changes method later.';

COMMENT ON COLUMN "commission_rule"."params" IS
  'Structured configuration for methods that need more than one column. FORMULA stores {"expression": "..."} over the field catalog in @eztruckr/types. Parsed and validated before the row is written; never evaluated with eval/Function/vm.';

-- A FORMULA rule without an expression is not a rule, and an expression on any
-- other method is a claim the engine will never read. Both are refused here,
-- so the table cannot hold a row that lies about what it does.
ALTER TABLE "commission_rule"
  ADD CONSTRAINT "commission_rule_params_match_method" CHECK (
    CASE WHEN "method" = 5
      THEN "params" ->> 'expression' IS NOT NULL AND length("params" ->> 'expression') > 0
      ELSE "params" IS NULL
    END
  );

-- ---------------------------------------------------------------------------
-- appliedRate stops being a percentage
-- ---------------------------------------------------------------------------
--
-- It was DECIMAL(5,4) NOT NULL bounded to [0,1], which is right for a stored
-- percentage and wrong for what this column now holds. For the two percent
-- methods it is still the rule's rate and still an operand. For the fixed and
-- formula methods no rate produced the amount, so the value is derived after
-- the fact for reporting — amount over the base the method works against —
-- and is not bounded by 1: a flat fee on a small backhaul is legitimately
-- several hundred percent of its base. It is also nullable now, for the cases
-- where no honest figure exists (a zero denominator). Null means "not
-- meaningful"; 0 would have meant "earned nothing".

ALTER TABLE "commission" DROP CONSTRAINT "commission_applied_rate_range";
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_applied_rate_range" CHECK (
    "appliedRate" IS NULL
    OR (
      "appliedRate" >= 0
      -- Rate-based methods (PERCENT_OF_BASE, PERCENT_OF_NET_RATE) keep the
      -- tight bound, since for them this really is a percentage.
      AND ("appliedMethod" NOT IN (1, 4) OR "appliedRate" <= 1)
    )
  );

-- ...and for those two methods the rate is the operand, so it cannot be absent.
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_rate_based_needs_rate" CHECK (
    "appliedMethod" NOT IN (1, 4) OR "appliedRate" IS NOT NULL
  );

COMMENT ON COLUMN "commission"."appliedRate" IS
  'The rate this commission was computed at (PERCENT_OF_BASE, PERCENT_OF_NET_RATE) or reports at (the fixed and formula methods, where it is derived as amount over base purely for vouchers). Nullable: null means no meaningful rate exists, never that nothing was earned.';

-- A formula commission is only reproducible if the expression and the values
-- it read are both frozen alongside the amount. The rule is editable data, so
-- without these two the figure becomes unverifiable the moment someone changes
-- it. Equally, these columns on a non-formula row would describe a computation
-- that never happened.
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_formula_records_its_inputs" CHECK (
    CASE WHEN "appliedMethod" = 5
      THEN "appliedFormulaExpression" IS NOT NULL AND "appliedFormulaFields" IS NOT NULL
      ELSE "appliedFormulaExpression" IS NULL AND "appliedFormulaFields" IS NULL
    END
  );

COMMENT ON COLUMN "commission"."appliedFormulaExpression" IS
  'FORMULA only. The expression as it stood when this row was computed, frozen so a later edit to the rule cannot make the amount unreproducible.';
COMMENT ON COLUMN "commission"."appliedFormulaFields" IS
  'FORMULA only. The catalog field values the expression actually read, e.g. {"net_rate":"16200.0000"}. With the expression, enough to recompute the amount by hand.';
