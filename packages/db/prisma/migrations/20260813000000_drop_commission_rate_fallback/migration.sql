-- Drop the SystemSetting commission-rate fallback.
--
-- `CommissionRule` becomes the only source of truth for what a driver or
-- helper is paid. The fallback meant two places to look for one number, and
-- the failure mode was silent: a missing, expired or mis-scoped rule would
-- quietly pay the system default rather than failing, and nobody would find
-- out until someone questioned a payout months later.
--
-- No rate information is lost. The company-wide baselines these columns held
-- (0.1500 driver, 0.0750 helper) already exist as unscoped, open-ended
-- CommissionRule rows at priority 0, which is what the resolver matches when
-- nothing narrower applies.
--
-- gasExpenseDeductionRate STAYS. It is not a per-role rate, so it has no
-- CommissionRule equivalent — putting it on a per-role rule would let a driver
-- rule and a helper rule disagree about the commissionable base of the same
-- shipment.

-- The existing CHECK spans all three rate columns, and Postgres drops a
-- multi-column constraint entirely when any column it references goes.
-- Dropping it explicitly and rebuilding it narrowed is the only way the
-- gasExpenseDeductionRate bound survives this migration — otherwise it
-- disappears silently, and nothing here would fail to say so.
ALTER TABLE "system_setting" DROP CONSTRAINT "system_setting_rate_ranges";

ALTER TABLE "system_setting" DROP COLUMN "driverCommissionRate";
ALTER TABLE "system_setting" DROP COLUMN "helperCommissionRate";

ALTER TABLE "system_setting"
  ADD CONSTRAINT "system_setting_rate_ranges"
  CHECK ("gasExpenseDeductionRate" >= 0 AND "gasExpenseDeductionRate" <= 1);

COMMENT ON COLUMN "system_setting"."gasExpenseDeductionRate" IS
  'Share of fuel spend deducted before commission is computed. System-wide: not a per-role rate, and has no CommissionRule equivalent.';
