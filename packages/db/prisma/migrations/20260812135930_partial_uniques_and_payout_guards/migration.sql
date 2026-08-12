-- Partial unique indexes, and the payout idempotency guards.
--
-- PART 1 — PARTIAL UNIQUES
-- Every natural key on a soft-deletable table is unique only among LIVE rows.
-- A full unique would let a deleted row reserve its code or reference number
-- forever, so the user could never recreate "CLT-SMT" after deleting it.
-- Prisma cannot express partial uniqueness, which is why these columns carry
-- no `@unique` in schema.prisma and are created here instead.
--
-- PART 2 — PAYOUT IDEMPOTENCY
-- `commission_payoutLineId_key` is deliberately a FULL unique (created by the
-- init migration, not here): a soft-deleted commission must still occupy its
-- payout line. The triggers below close the remaining routes by which the same
-- work could be paid twice.

-- ==========================================================================
-- PART 1 — partial unique indexes
-- ==========================================================================

CREATE UNIQUE INDEX "user_email_live_key"
  ON "user" ("email") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "user_crew_member_live_key"
  ON "user" ("crewMemberId") WHERE "deletedAt" IS NULL AND "crewMemberId" IS NOT NULL;

CREATE UNIQUE INDEX "user_profile_user_live_key"
  ON "user_profile" ("userId") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "truck_plate_number_live_key"
  ON "truck" ("plateNumber") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "crew_member_employee_code_live_key"
  ON "crew_member" ("employeeCode") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "client_code_live_key"
  ON "client" ("code") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "third_party_code_live_key"
  ON "third_party" ("code") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "route_code_live_key"
  ON "route" ("code") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "expense_category_code_live_key"
  ON "expense_category" ("code") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "shipment_number_live_key"
  ON "shipment" ("shipmentNumber") WHERE "deletedAt" IS NULL;

-- At most one live liquidation per shipment; a superseded one can be replaced.
CREATE UNIQUE INDEX "liquidation_shipment_live_key"
  ON "liquidation" ("shipmentId") WHERE "deletedAt" IS NULL;

CREATE UNIQUE INDEX "receipt_storage_key_live_key"
  ON "receipt" ("storageKey") WHERE "deletedAt" IS NULL;

-- A receipt backs at most one live line, and at most one live billable expense.
CREATE UNIQUE INDEX "liquidation_line_receipt_live_key"
  ON "liquidation_line" ("receiptId") WHERE "deletedAt" IS NULL AND "receiptId" IS NOT NULL;

CREATE UNIQUE INDEX "billable_expense_receipt_live_key"
  ON "billable_expense" ("receiptId") WHERE "deletedAt" IS NULL AND "receiptId" IS NOT NULL;

CREATE UNIQUE INDEX "payout_run_number_live_key"
  ON "payout_run" ("runNumber") WHERE "deletedAt" IS NULL;

-- A trip has at most one live driver commission and one live helper commission.
-- Partial, so a soft-deleted commission can be recomputed — which is exactly
-- why the trigger below refuses to soft-delete one that has been paid.
CREATE UNIQUE INDEX "commission_shipment_role_live_key"
  ON "commission" ("shipmentId", "role") WHERE "deletedAt" IS NULL;

-- ==========================================================================
-- PART 2 — payout idempotency
-- ==========================================================================

-- The PAID code appears once in SQL, here, so the triggers below never repeat
-- a bare literal. Mirrors PayoutRunStatus.PAID in @eztruckr/types.
CREATE OR REPLACE FUNCTION eztruckr_payout_status_paid()
RETURNS SMALLINT AS $$
  SELECT 3::SMALLINT;
$$ LANGUAGE sql IMMUTABLE;

COMMENT ON FUNCTION eztruckr_payout_status_paid() IS
  'PayoutRunStatus.PAID (@eztruckr/types). Single source of this code in SQL.';

-- Is this commission attached to a payout line in a run that has been paid?
CREATE OR REPLACE FUNCTION eztruckr_commission_is_paid(commission_payout_line_id TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  run_status SMALLINT;
BEGIN
  IF commission_payout_line_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT run.status
    INTO run_status
    FROM "payout_line" line
    JOIN "payout_run" run ON run.id = line."payoutRunId"
   WHERE line.id = commission_payout_line_id;

  RETURN run_status = eztruckr_payout_status_paid();
END;
$$ LANGUAGE plpgsql;

-- 1. A paid commission's payout link can be neither moved nor cleared.
CREATE OR REPLACE FUNCTION eztruckr_commission_payout_link_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."payoutLineId" IS NOT DISTINCT FROM OLD."payoutLineId" THEN
    RETURN NEW;
  END IF;

  IF eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'commission % was paid by payout line % and cannot be re-paid',
      OLD.id, OLD."payoutLineId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER commission_payout_link_is_immutable
BEFORE UPDATE ON "commission"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_commission_payout_link_is_immutable();

-- 2. A paid commission cannot be SOFT-deleted.
--
--    This is the guard that soft delete makes necessary. The unique index on
--    (shipmentId, role) is partial, so soft-deleting a paid commission would
--    free that slot, a fresh commission could be created for the same trip and
--    role, and the same work would be paid a second time. The original row
--    would still look paid, so nothing would appear wrong.
CREATE OR REPLACE FUNCTION eztruckr_paid_commission_no_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."deletedAt" IS NULL
     AND NEW."deletedAt" IS NOT NULL
     AND eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'commission % has been paid and cannot be deleted; deleting it would free its (shipment, role) slot and allow the same work to be paid again',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_commission_no_soft_delete
BEFORE UPDATE ON "commission"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_commission_no_soft_delete();

-- 3. A paid commission cannot be hard-deleted either. Application code cannot
--    reach a hard delete at all, but a trigger holds for raw SQL too.
CREATE OR REPLACE FUNCTION eztruckr_paid_commission_no_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'commission % belongs to a paid payout run and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_commission_no_delete
BEFORE DELETE ON "commission"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_commission_no_delete();

-- 4. Deleting a payout line in a paid run would SET NULL its commission link
--    (per the FK), silently releasing a paid commission.
CREATE OR REPLACE FUNCTION eztruckr_paid_payout_line_no_delete()
RETURNS TRIGGER AS $$
DECLARE
  owning_run_status SMALLINT;
BEGIN
  SELECT status INTO owning_run_status FROM "payout_run" WHERE id = OLD."payoutRunId";

  IF owning_run_status = eztruckr_payout_status_paid() THEN
    RAISE EXCEPTION
      'payout line % belongs to a paid run and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_payout_line_no_delete
BEFORE DELETE ON "payout_line"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_payout_line_no_delete();

-- 5. PAID is terminal: a paid run can never be voided or reopened. Soft-
--    deleting the run is refused for the same reason.
CREATE OR REPLACE FUNCTION eztruckr_paid_payout_run_is_terminal()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = eztruckr_payout_status_paid() AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION
      'payout run % is PAID; that status is terminal and cannot change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = eztruckr_payout_status_paid()
     AND OLD."deletedAt" IS NULL
     AND NEW."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'payout run % is PAID and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER paid_payout_run_is_terminal
BEFORE UPDATE ON "payout_run"
FOR EACH ROW
EXECUTE FUNCTION eztruckr_paid_payout_run_is_terminal();
