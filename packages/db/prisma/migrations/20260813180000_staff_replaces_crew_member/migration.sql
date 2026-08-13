-- One table for everyone who works here, and dispatch managers in it.
--
-- WHY THIS IS A RENAME AND NOT A NEW TABLE. A dispatch manager holds a trip's
-- cash float and is answerable for accounting for it, which makes them a
-- liquidation custodian — but they do not drive, do not help, and have no crew
-- record. The alternative was `liquidation.custodianId` pointing at either a
-- crew member or a user, which is one column doing two jobs held together by a
-- convention: the defect this codebase keeps finding. Unifying the people
-- instead leaves every foreign key pointing at exactly one place, and costs
-- nothing but names.
--
-- EVERY CHANGE HERE IS A RENAME. Not one column is dropped and re-added, and
-- that is load-bearing rather than tidy: `user."crewMemberId"` carries the live
-- links between logins and people, and the seed keys its idempotency on that
-- column rather than on the email (see seed.ts). A drop-and-add would null
-- every link, and the next seed would try to create a second login for the same
-- person and collide on the partial unique index below.
--
-- WHAT DOES NOT RENAME. Only the identifier for a PERSON. `crew_deduction`,
-- `commission.role` and the driver/helper slots on `shipment` keep their names,
-- because "crew" still means something narrower and true: the people on the
-- truck. `crew_deduction."staffId"` reads oddly for a moment and is exactly
-- right — it is a debt owed by a member of staff, who may or may not be crew.

-- ---------------------------------------------------------------------------
-- 1. The table
-- ---------------------------------------------------------------------------

ALTER TABLE "crew_member" RENAME TO "staff";
ALTER TABLE "staff" RENAME COLUMN "employeeCode" TO "staffCode";

-- Postgres keeps the old names on constraints and indexes when a table is
-- renamed, so each one is renamed explicitly. Prisma derives the names it
-- expects from the model, and a mismatch shows up as permanent drift.
ALTER TABLE "staff" RENAME CONSTRAINT "crew_member_pkey" TO "staff_pkey";
ALTER TABLE "staff" RENAME CONSTRAINT "crew_member_createdBy_fkey" TO "staff_createdBy_fkey";
ALTER TABLE "staff" RENAME CONSTRAINT "crew_member_updatedBy_fkey" TO "staff_updatedBy_fkey";
ALTER TABLE "staff" RENAME CONSTRAINT "crew_member_deletedBy_fkey" TO "staff_deletedBy_fkey";
ALTER TABLE "staff" RENAME CONSTRAINT "crew_member_created_by_required" TO "staff_created_by_required";
ALTER TABLE "staff"
  RENAME CONSTRAINT "crew_member_soft_delete_consistent" TO "staff_soft_delete_consistent";

ALTER INDEX "crew_member_isActive_idx" RENAME TO "staff_isActive_idx";
ALTER INDEX "crew_member_lastName_firstName_idx" RENAME TO "staff_lastName_firstName_idx";
ALTER INDEX "crew_member_deletedAt_idx" RENAME TO "staff_deletedAt_idx";
ALTER INDEX "crew_member_employee_code_live_key" RENAME TO "staff_code_live_key";

-- ---------------------------------------------------------------------------
-- 2. Everything that points at a person
-- ---------------------------------------------------------------------------

ALTER TABLE "user" RENAME COLUMN "crewMemberId" TO "staffId";
ALTER TABLE "commission" RENAME COLUMN "crewMemberId" TO "staffId";
ALTER TABLE "allowance" RENAME COLUMN "crewMemberId" TO "staffId";
ALTER TABLE "crew_deduction" RENAME COLUMN "crewMemberId" TO "staffId";
ALTER TABLE "adjustment" RENAME COLUMN "crewMemberId" TO "staffId";
ALTER TABLE "payout_line" RENAME COLUMN "crewMemberId" TO "staffId";

ALTER TABLE "user" RENAME CONSTRAINT "user_crewMemberId_fkey" TO "user_staffId_fkey";
ALTER TABLE "commission"
  RENAME CONSTRAINT "commission_crewMemberId_fkey" TO "commission_staffId_fkey";
ALTER TABLE "allowance" RENAME CONSTRAINT "allowance_crewMemberId_fkey" TO "allowance_staffId_fkey";
ALTER TABLE "crew_deduction"
  RENAME CONSTRAINT "crew_deduction_crewMemberId_fkey" TO "crew_deduction_staffId_fkey";
ALTER TABLE "adjustment"
  RENAME CONSTRAINT "adjustment_crewMemberId_fkey" TO "adjustment_staffId_fkey";
ALTER TABLE "payout_line"
  RENAME CONSTRAINT "payout_line_crewMemberId_fkey" TO "payout_line_staffId_fkey";

ALTER INDEX "commission_crewMemberId_idx" RENAME TO "commission_staffId_idx";
ALTER INDEX "allowance_crewMemberId_idx" RENAME TO "allowance_staffId_idx";
ALTER INDEX "crew_deduction_crewMemberId_idx" RENAME TO "crew_deduction_staffId_idx";
ALTER INDEX "adjustment_crewMemberId_idx" RENAME TO "adjustment_staffId_idx";
ALTER INDEX "payout_line_crewMemberId_idx" RENAME TO "payout_line_staffId_idx";

-- The one-live-login guarantee. Prisma cannot express partial uniqueness, so
-- this index is hand-written and a rename here is the only thing that keeps it.
-- BOTH conjuncts of the predicate are carried over deliberately: dropping
-- `deletedAt IS NULL` would permanently block re-linking a login after a soft
-- delete, and dropping `"staffId" IS NOT NULL` would make every office login,
-- which has none, collide with every other.
ALTER INDEX "user_crew_member_live_key" RENAME TO "user_staff_live_key";

-- ---------------------------------------------------------------------------
-- 3. Dispatch managers
-- ---------------------------------------------------------------------------

-- Widened to admit code 3. Dropped and recreated rather than renamed, because
-- the permitted set itself changes.
ALTER TABLE "staff" DROP CONSTRAINT "crew_member_eligible_roles_valid";
ALTER TABLE "staff"
  ADD CONSTRAINT "staff_eligible_roles_valid"
  CHECK ("eligibleRoles" IS NULL OR "eligibleRoles" <@ ARRAY[1, 2, 3]::SMALLINT[]);

-- `commission.role` and `commission_rule.role` deliberately KEEP `IN (1, 2)`.
-- They are no longer "every code in the set" — they are the crew subset of it,
-- and that is now the thing standing between a dispatch manager and a
-- commission they do not earn. Renamed so the names stop claiming otherwise.
ALTER TABLE "commission"
  RENAME CONSTRAINT "commission_role_code_valid" TO "commission_role_is_a_crew_role";
ALTER TABLE "commission_rule"
  RENAME CONSTRAINT "commission_rule_role_code_valid" TO "commission_rule_role_is_a_crew_role";

-- ---------------------------------------------------------------------------
-- 4. Comments, which name the code set and the table
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN "staff"."eligibleRoles" IS
  'Code set StaffRole (@eztruckr/types): 1 DRIVER, 2 HELPER, 3 DISPATCH_MANAGER. Roles this person MAY fill; the role actually filled on a trip is recorded on commission.role, which permits only the crew subset (1, 2).';

COMMENT ON COLUMN "staff"."staffCode" IS
  'The person''s code on paper. Partial-unique WHERE "deletedAt" IS NULL.';

COMMENT ON COLUMN "user"."staffId" IS
  'Set only for role = CREW: the hard link that scopes a portal login to exactly one staff member''s records. An office login has none — a dispatch manager is a staff row and signs in as OPERATIONS, which is not scoped to one person.';

COMMENT ON COLUMN "liquidation"."custodianId" IS
  'The staff member answerable for accounting for this cash. Nullable because the trip''s first liquidation is created at booking, before anybody is assigned. NOT the same as an allowance''s recipient: a helper can be handed ferry money the driver remains answerable for. Not necessarily on the truck either — a dispatch manager holds a trip''s float without driving or helping.';
