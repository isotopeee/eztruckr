-- Split the gas deduction rate into an input and an output.
--
-- `appliedGasDeductionRate` was doing two jobs: holding the rate a person had
-- asked this shipment to use, AND holding the rate the engine froze once it
-- computed. `gasRateOverrideReason` was left to disambiguate them — a non-null
-- reason meant the rate was a deliberate override, a null one meant it was a
-- frozen copy of the system default.
--
-- That decoded correctly, but only by convention:
--
--   * No CHECK could enforce it. Postgres had exactly the same missing
--     information, so there was nothing to constrain.
--   * It made recomputation depend on a reason STRING being present, to decide
--     whether to keep the stored rate or re-read the system default. An
--     override written by any future code path without a reason would silently
--     become a "frozen default" and be overwritten on the next recompute — the
--     crew paid a different figure, with nothing raising.
--
-- After this migration the two are separate columns, override-ness is
-- structural rather than inferred, and the constraints below can finally say
-- what was previously only documented.

-- AlterTable
ALTER TABLE "shipment" ADD COLUMN     "gasRateOverride" DECIMAL(5,4);

-- Backfill. A shipment carrying a reason had a deliberate override, and its
-- value is whatever sits in the applied column — either because it was never
-- computed, or because computation froze the override itself. Rows with no
-- reason held a frozen copy of the default, which is an output and stays put.
UPDATE "shipment"
   SET "gasRateOverride" = "appliedGasDeductionRate"
 WHERE "gasRateOverrideReason" IS NOT NULL;

-- The override and its reason travel together, in both directions. This is the
-- constraint the single-column form could not express, and the reason for the
-- whole migration.
ALTER TABLE "shipment"
  ADD CONSTRAINT "shipment_gas_rate_override_needs_reason" CHECK (
    ("gasRateOverride" IS NULL) = ("gasRateOverrideReason" IS NULL)
  );

ALTER TABLE "shipment"
  ADD CONSTRAINT "shipment_gas_rate_override_range" CHECK (
    "gasRateOverride" IS NULL OR ("gasRateOverride" >= 0 AND "gasRateOverride" <= 1)
  );

COMMENT ON COLUMN "shipment"."gasRateOverride" IS
  'INPUT. The gas deduction rate somebody deliberately asked this shipment to use instead of the system default. Null means use the default. Always accompanied by gasRateOverrideReason, enforced by CHECK.';
COMMENT ON COLUMN "shipment"."gasRateOverrideReason" IS
  'Why the override was applied. Mandatory whenever gasRateOverride is set: this rate moves the commission base for every crew member on the trip, so an unexplained override is indistinguishable from a typo at review time.';
COMMENT ON COLUMN "shipment"."appliedGasDeductionRate" IS
  'OUTPUT. The rate the last computation actually used — the override if there was one, otherwise the system default as it stood then. Null until commissions are computed. Written only by the engine, never by a request.';
