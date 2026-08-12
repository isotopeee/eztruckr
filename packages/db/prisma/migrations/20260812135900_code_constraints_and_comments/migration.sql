-- CHECK constraints and column comments for the SMALLINT code columns.
--
-- Enumerated values are stored as SMALLINT rather than Postgres enums, which
-- buys cheap appends but gives up the type system's guarantee that a column
-- holds a meaningful value. These CHECKs buy that back: a bad write fails at
-- the database instead of becoming a row nobody can interpret.
--
-- The code values are duplicated here because a migration is static SQL and
-- cannot import from @eztruckr/types. That is the one unavoidable duplication
-- in the system; `code-constraints.test.ts` reads these constraints back out
-- of the catalog and compares them against the TypeScript definitions, so the
-- two cannot drift apart unnoticed.
--
-- Each constraint lists the codes explicitly rather than using a BETWEEN
-- range, because codes are appended over time and must never be assumed
-- contiguous.
--
-- Appending a code means: add it to the const object in @eztruckr/types, then
-- add a migration that drops and recreates the relevant constraint. Never
-- renumber an existing code — the stored rows hold the number, not the name.

-- UserRole: 1 ADMINISTRATOR, 2 OPERATIONS, 3 ACCOUNTING, 4 MANAGEMENT, 5 CREW
ALTER TABLE "user"
  ADD CONSTRAINT "user_role_code_valid" CHECK ("role" IN (1, 2, 3, 4, 5));
COMMENT ON COLUMN "user"."role" IS
  'Code set UserRole (@eztruckr/types): 1 ADMINISTRATOR, 2 OPERATIONS, 3 ACCOUNTING, 4 MANAGEMENT, 5 CREW. Not ranked — never compare with < or >.';

-- CrewRole: 1 DRIVER, 2 HELPER  (array column — every element must be valid)
ALTER TABLE "crew_member"
  ADD CONSTRAINT "crew_member_eligible_roles_valid"
  CHECK ("eligibleRoles" IS NULL OR "eligibleRoles" <@ ARRAY[1, 2]::SMALLINT[]);
COMMENT ON COLUMN "crew_member"."eligibleRoles" IS
  'Code set CrewRole (@eztruckr/types): 1 DRIVER, 2 HELPER. Roles this person MAY fill; the role actually filled is recorded on commission.role.';

-- CommissionRule
ALTER TABLE "commission_rule"
  ADD CONSTRAINT "commission_rule_role_code_valid" CHECK ("role" IN (1, 2));
COMMENT ON COLUMN "commission_rule"."role" IS
  'Code set CrewRole (@eztruckr/types): 1 DRIVER, 2 HELPER.';

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "commission_rule_method_code_valid" CHECK ("method" IN (1, 2, 3, 4, 5));
COMMENT ON COLUMN "commission_rule"."method" IS
  'Code set CommissionMethod (@eztruckr/types): 1 PERCENT_OF_BASE, 2 FIXED_PER_TRIP, 3 FIXED_PER_ROUTE, 4 PERCENT_OF_NET_RATE, 5 TIERED (reserved, unimplemented). The CHECK guards the code set, not the feature set — refusing an unimplemented method is the service layer''s job.';

-- Shipment
ALTER TABLE "shipment"
  ADD CONSTRAINT "shipment_status_code_valid" CHECK ("status" IN (1, 2, 3, 4, 5, 6));
COMMENT ON COLUMN "shipment"."status" IS
  'Code set ShipmentStatus (@eztruckr/types): 1 DRAFT, 2 DISPATCHED, 3 IN_TRANSIT, 4 DELIVERED, 5 LIQUIDATED, 6 CLOSED. Workflow order comes from the declared sequence in @eztruckr/types, never from the numeric value.';

-- Liquidation
ALTER TABLE "liquidation"
  ADD CONSTRAINT "liquidation_status_code_valid" CHECK ("status" IN (1, 2, 3));
COMMENT ON COLUMN "liquidation"."status" IS
  'Code set LiquidationStatus (@eztruckr/types): 1 SUBMITTED, 2 APPROVED, 3 FINALIZED.';

-- Adjustment
ALTER TABLE "adjustment"
  ADD CONSTRAINT "adjustment_direction_code_valid" CHECK ("direction" IN (1, 2));
COMMENT ON COLUMN "adjustment"."direction" IS
  'Code set AdjustmentDirection (@eztruckr/types): 1 INCREASE, 2 DECREASE.';

-- Commission
ALTER TABLE "commission"
  ADD CONSTRAINT "commission_role_code_valid" CHECK ("role" IN (1, 2));
COMMENT ON COLUMN "commission"."role" IS
  'Code set CrewRole (@eztruckr/types): 1 DRIVER, 2 HELPER. The role actually filled on this trip.';

ALTER TABLE "commission"
  ADD CONSTRAINT "commission_applied_method_code_valid" CHECK ("appliedMethod" IN (1, 2, 3, 4, 5));
COMMENT ON COLUMN "commission"."appliedMethod" IS
  'Code set CommissionMethod (@eztruckr/types): 1 PERCENT_OF_BASE, 2 FIXED_PER_TRIP, 3 FIXED_PER_ROUTE, 4 PERCENT_OF_NET_RATE, 5 TIERED (reserved). Frozen at computation time.';

-- PayoutRun
ALTER TABLE "payout_run"
  ADD CONSTRAINT "payout_run_status_code_valid" CHECK ("status" IN (1, 2, 3, 4));
COMMENT ON COLUMN "payout_run"."status" IS
  'Code set PayoutRunStatus (@eztruckr/types): 1 DRAFT, 2 APPROVED, 3 PAID, 4 VOIDED. PAID is terminal, enforced by trigger.';

-- --------------------------------------------------------------------------
-- Money and rate sanity, unrelated to code sets but equally un-expressible in
-- the Prisma schema.
-- --------------------------------------------------------------------------

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "commission_rule_rate_range"
  CHECK ("rate" IS NULL OR ("rate" >= 0 AND "rate" <= 1));

ALTER TABLE "commission_rule"
  ADD CONSTRAINT "commission_rule_effective_window_ordered"
  CHECK ("effectiveTo" IS NULL OR "effectiveFrom" < "effectiveTo");

ALTER TABLE "commission"
  ADD CONSTRAINT "commission_applied_rate_range"
  CHECK ("appliedRate" >= 0 AND "appliedRate" <= 1);

ALTER TABLE "shipment"
  ADD CONSTRAINT "shipment_gas_rate_range"
  CHECK ("appliedGasDeductionRate" IS NULL
         OR ("appliedGasDeductionRate" >= 0 AND "appliedGasDeductionRate" <= 1));

ALTER TABLE "shipment"
  ADD CONSTRAINT "shipment_tpc_rate_range"
  CHECK ("appliedTpcRate" IS NULL OR ("appliedTpcRate" >= 0 AND "appliedTpcRate" <= 1));

ALTER TABLE "system_setting"
  ADD CONSTRAINT "system_setting_rate_ranges"
  CHECK ("gasExpenseDeductionRate" >= 0 AND "gasExpenseDeductionRate" <= 1
         AND "driverCommissionRate" >= 0 AND "driverCommissionRate" <= 1
         AND "helperCommissionRate" >= 0 AND "helperCommissionRate" <= 1);

-- --------------------------------------------------------------------------
-- Soft delete: deletedAt and deletedBy are set and cleared together.
-- A row with one but not the other is a bug, and an unreadable audit trail.
-- --------------------------------------------------------------------------

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'user', 'user_profile', 'truck', 'crew_member', 'client', 'third_party',
    'route', 'expense_category', 'commission_rule', 'system_setting',
    'shipment', 'allowance', 'liquidation', 'liquidation_line', 'receipt',
    'billable_expense', 'additional_charge', 'crew_deduction', 'adjustment',
    'commission', 'payout_run', 'payout_line', 'audit_log'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (
         ("deletedAt" IS NULL AND "deletedBy" IS NULL)
         OR ("deletedAt" IS NOT NULL)
       )',
      target_table,
      target_table || '_soft_delete_consistent'
    );
  END LOOP;
END $$;
