-- WHAT AN ACCOUNT IS FOR, in the office's own words.
--
-- `sequence` made two of one person's accounts distinguishable — "account 1"
-- and "account 2" are different rows and always will be — without making them
-- RECOGNISABLE. The person who opened the second one knew why: it is the Manila
-- leg, or the second advance, or the ferry money. Nothing recorded that, so a
-- week later the only way to tell which voucher an account belonged to was to
-- open it and read the claims.
--
-- OPTIONAL AND NEVER LOAD-BEARING. Nothing is derived from it, nothing is
-- refused for the lack of it, and it is not an identifier: two accounts may
-- carry the same description, or none, and the number still tells them apart.
-- That is deliberate — a free-text field that anything depends on is a field
-- somebody renames and breaks.
--
-- NO NOT-BLANK CHECK, matching `referenceNumber` and every other optional text
-- column here rather than `adjustment.reason`, which is required and is the
-- entire content of the row it sits on. `optionalText` collapses a blank to
-- null before it arrives, so the distinction the column can hold is "said
-- something" versus "said nothing".
ALTER TABLE "liquidation" ADD COLUMN "description" TEXT;

COMMENT ON COLUMN liquidation."description" IS
  'What this account is for, in the office''s own words — "Manila leg", "second advance". Optional and never load-bearing: `sequence` identifies an account and nothing is derived from this. Distinct from `remarks`, which annotates a submission or an approval, and from `referenceNumber`, which is a number somebody else issued.';
