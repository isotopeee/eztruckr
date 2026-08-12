-- AlterTable
ALTER TABLE "additional_charge" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "adjustment" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "allowance" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "audit_log" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "billable_expense" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "client" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "commission" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "commission_rule" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "crew_deduction" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "crew_member" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "expense_category" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "liquidation" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "liquidation_line" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payout_line" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "payout_run" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "receipt" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "route" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "shipment" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "system_setting" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "third_party" ALTER COLUMN "createdBy" DROP NOT NULL;

-- AlterTable
ALTER TABLE "truck" ALTER COLUMN "createdBy" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- Restore the guarantee that Prisma just gave up.
--
-- `createdBy` is now nullable in the Prisma schema, but NOT because it is
-- optional in the domain. It is stamped by the audit extension at query time,
-- which the generated TypeScript cannot know about — so a required column made
-- every single `create()` in the codebase demand a `createdBy` the caller must
-- never supply. That would have turned "stamped automatically, never settable
-- from a request body" into "typed as mandatory, passed by hand everywhere".
--
-- These CHECK constraints keep the column mandatory where it counts, in the
-- database. Prisma's differ does not track CHECK constraints, so a nullable
-- column plus a NOT NULL check produces no schema drift.
--
-- `user` and `user_profile` are deliberately excluded: the bootstrap
-- administrator has no creator, and a self-registering user owns their own
-- first profile row.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  target_table TEXT;
BEGIN
  FOREACH target_table IN ARRAY ARRAY[
    'truck', 'crew_member', 'client', 'third_party', 'route',
    'expense_category', 'commission_rule', 'system_setting', 'shipment',
    'allowance', 'liquidation', 'liquidation_line', 'receipt',
    'billable_expense', 'additional_charge', 'crew_deduction', 'adjustment',
    'commission', 'payout_run', 'payout_line', 'audit_log'
  ]
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ("createdBy" IS NOT NULL)',
      target_table,
      target_table || '_created_by_required'
    );
  END LOOP;
END $$;
