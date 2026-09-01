-- WHAT WAS SPENT and WHAT THE CLIENT IS CHARGED, told apart.
--
-- WHAT THIS FIXES. One `amount` column stood for both, so the only deal the
-- table could express was full recovery. Every real shortfall — a ₱2,000 permit
-- against a client who agreed to ₱1,500, a crane hour absorbed to keep an
-- account, a surcharge half passed on — had to be recorded by understating what
-- was paid, which then disagreed with the receipt attached to the same row. The
-- unrecovered part was not merely unreported: it was denied, because the trip
-- claimed to have spent the smaller figure.
--
-- The gap is NOT STORED. Revenue counts `billedAmount`, cost counts `amount`,
-- and what the company absorbed is the difference the two leave behind — for
-- the same reason gross profit is derived rather than columned: a third number
-- maintained beside the two it comes from is a number that can contradict them.
--
-- BACKFILLED TO THE AMOUNT, which is not a guess. Every existing row was
-- written when one column meant both things, so its `amount` already IS what
-- the client was charged; copying it states what those rows have always said
-- and leaves every trip's revenue, cost and margin exactly where they were.
-- Nothing here needs re-checking by hand afterwards.
--
-- Added nullable and tightened afterwards, in three statements rather than one
-- DEFAULT: a default would have to be a constant, and the correct value is a
-- different one per row.
ALTER TABLE "billable_expense" ADD COLUMN "billedAmount" DECIMAL(15,4);

UPDATE "billable_expense" SET "billedAmount" = "amount";

ALTER TABLE "billable_expense" ALTER COLUMN "billedAmount" SET NOT NULL;
