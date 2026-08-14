-- Drop the natural-key `code` columns from all six master-data tables.
--
-- WHY. Nothing keyed off them. No service looked a record up by code, no money
-- logic referenced one (the gas deduction is a flat rate, not a FUEL lookup),
-- and the justification written on `naturalCodeSchema` — "these appear in
-- exports and printed vouchers" — described features that do not exist. What
-- they actually did was carry the partial unique that made each table's natural
-- key work, plus give search something extra to match on.
--
-- CHEAP TO REVERSE, which is why doing it now was defensible: a code lives only
-- on master data and is never frozen onto a transaction, so re-adding one later
-- is a nullable column plus a bounded backfill, with no history to rewrite.
-- Contrast `payeeRequired`, which IS copied onto every cost row — adding that
-- late cost 22 deleted lines and eight recomputed liquidations.
--
-- THE REPLACEMENT IS THE POINT. `name` was unique on nothing, so dropping the
-- codes without re-homing the constraint would have left every one of these
-- tables with no natural key at all: two identical clients, two "Fuel"
-- categories, and a seed whose find-by-natural-key idempotency silently
-- duplicates everything on the second run.

-- --------------------------------------------------------------------------
-- 1. Drop the columns. Their partial unique indexes go with them.
-- --------------------------------------------------------------------------

ALTER TABLE "staff" DROP COLUMN "staffCode";
ALTER TABLE "client" DROP COLUMN "code";
ALTER TABLE "third_party" DROP COLUMN "code";
ALTER TABLE "payee" DROP COLUMN "code";
ALTER TABLE "route" DROP COLUMN "code";
ALTER TABLE "expense_category" DROP COLUMN "code";

-- --------------------------------------------------------------------------
-- 2. Re-home the natural key onto `name` — for five of the six
-- --------------------------------------------------------------------------

CREATE UNIQUE INDEX client_name_live_key
  ON client USING btree (name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX third_party_name_live_key
  ON third_party USING btree (name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX payee_name_live_key
  ON payee USING btree (name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX route_name_live_key
  ON route USING btree (name) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX expense_category_name_live_key
  ON expense_category USING btree (name) WHERE ("deletedAt" IS NULL);

-- STAFF GETS NO REPLACEMENT, and that is a decision rather than an oversight.
-- Two people working here can genuinely be called Jose Santos, so a unique on
-- (firstName, lastName) would refuse a legitimate hire, and the only way to
-- satisfy it would be to type a discriminator into a name field that means
-- something else. Duplicate staff rows are now representable; the office tells
-- them apart by phone, email or hire date. If a real employee number ever
-- exists on paper, add it back as its own column — that is a small migration
-- and a bounded backfill from HR records.

COMMENT ON COLUMN staff."firstName" IS
  'Staff have no natural key: `staffCode` was dropped and a name cannot replace it, because two employees may share one.';
