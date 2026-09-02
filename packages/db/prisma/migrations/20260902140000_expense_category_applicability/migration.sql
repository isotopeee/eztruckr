-- Where an expense category is OFFERED: a trip's money, the company's own, or
-- both.
--
-- WHAT THIS FIXES. `operation_expense` classifies against the same
-- `expense_category` as every trip-level cost, which is right — fuel is fuel
-- whether it went into a truck on a job or the office pickup, and a second
-- category table would make "what did we spend on repairs this year" a UNION
-- over two lists somebody has to keep in step by hand. What it left behind was
-- a table with no statement of where each category APPLIES, and four pickers
-- that all fetch it unfiltered. The first "Office rent" category added to run
-- the overhead ledger would have appeared in a CREW MEMBER'S LIQUIDATION
-- DROPDOWN, on the road, beside Fuel and Toll.
--
-- SO THE MISSING THING WAS A COLUMN, NOT A TABLE — the rule this schema keeps
-- rediscovering. Two of them, because a category is legitimately offered in
-- both places and one column that had to pick a side could not say so.
--
-- THE DEFAULTS ARE ASYMMETRIC AND THAT IS THE POINT. Everything in this table
-- predates the overhead ledger and is therefore a trip category, so
-- true/false backfills every existing row correctly with no UPDATE at all and
-- leaves the crew's picker showing exactly what it showed yesterday. Marking
-- one as overhead is then a deliberate act — the same argument that has
-- `requiresPayee` default to the strict answer.
--
-- NOT FROZEN ONTO THE ROWS THEY GOVERN, unlike `payeeRequired`. That flag is a
-- rule about what a written row had to contain, so each row keeps its own copy;
-- this decides what a picker OFFERS, which is the `isActive` question. Relaxing
-- it later leaves every past row reading correctly and simply stops the
-- category being chosen again.

-- AlterTable
ALTER TABLE "expense_category"
  ADD COLUMN "offeredOnTrips" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "offeredOnOverhead" BOOLEAN NOT NULL DEFAULT false;

-- A category offered nowhere cannot be filed against from any screen in the
-- system. It is not a harmless empty state: it is a row that silently cannot be
-- used, which is the kind of thing found months later by somebody wondering why
-- their category never appears. Refused here rather than in a service, because
-- both flags can be cleared by two separate PATCHes that are each individually
-- legal.
ALTER TABLE expense_category ADD CONSTRAINT expense_category_offered_somewhere
  CHECK ("offeredOnTrips" OR "offeredOnOverhead");

COMMENT ON COLUMN expense_category."offeredOnTrips" IS
  'Whether this category is offered on the trip-side forms: liquidation lines, billable expenses and company-paid expenses. Defaults true, which is what every category predating the overhead ledger is.';
COMMENT ON COLUMN expense_category."offeredOnOverhead" IS
  'Whether this category is offered on the operation-expense ledger. Defaults false so an existing category does not silently become an overhead one. Both flags may be true — fuel and repairs occur on a trip and off it — and expense_category_offered_somewhere refuses neither.';
