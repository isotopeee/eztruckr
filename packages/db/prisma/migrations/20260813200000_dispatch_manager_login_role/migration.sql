-- A dispatch manager can sign in.
--
-- `UserRole` gains 6 DISPATCH_MANAGER. They dispatch trips AND hold their cash
-- floats, which is a combination no existing role has: OPERATIONS dispatches
-- but never holds cash, and CREW holds cash but does not dispatch.
--
-- WHAT THEY DELIBERATELY CANNOT DO is decide a liquidation or release cash.
-- They are custodians, so either would let them sign off their own float. That
-- exclusion lives in `role-policy.ts` rather than here, because it is about
-- routes rather than rows — but it is the reason this role exists separately
-- instead of being spelled OPERATIONS.
--
-- Their login also NAMES A STAFF ROW, which until now only a crew login did.
-- The two are linked for different reasons: a crew link is the scope key every
-- crew-facing query filters on, while a dispatch manager is not scoped at all
-- and is linked so the system can tell which floats are theirs. There is no
-- CHECK for that rule — it has never had one — and it stays in
-- `hasStaffLinkMatchingRole`, which is now the only place it is written.

ALTER TABLE "user" DROP CONSTRAINT "user_role_code_valid";
ALTER TABLE "user"
  ADD CONSTRAINT "user_role_code_valid" CHECK ("role" IN (1, 2, 3, 4, 5, 6));

COMMENT ON COLUMN "user"."role" IS
  'Code set UserRole (@eztruckr/types): 1 ADMINISTRATOR, 2 OPERATIONS, 3 ACCOUNTING, 4 MANAGEMENT, 5 CREW, 6 DISPATCH_MANAGER. Not ranked — membership, never comparison.';

COMMENT ON COLUMN "user"."staffId" IS
  'Which staff member this login belongs to. Required for CREW and DISPATCH_MANAGER and forbidden for every other role. A crew login is SCOPED by it; a dispatch manager is not, and carries it so their own floats can be told apart from everyone else''s.';
