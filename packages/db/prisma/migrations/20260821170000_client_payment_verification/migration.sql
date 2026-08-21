-- A second pair of eyes on a recorded client payment.
--
-- WHAT THIS FIXES. `client_payment` arrived with recording restricted to
-- ADMINISTRATOR and ACCOUNTING, which described who was trusted rather than who
-- does the work: a dispatch manager is the one talking to the client whose
-- freight they moved, and is routinely the first to know a payment landed.
-- Widening the write list alone would have been the wrong fix — it would have
-- let a receipt be booked with nobody obliged to match it to anything.
--
-- SO THE TWO ARRIVE TOGETHER. Dispatch records; accounting checks. The check is
-- a state on the payment row rather than a second table, because unlike an
-- allowance request there is no ask preceding the money — the cash already
-- arrived, and what is in question is the RECORD of it. That is the
-- liquidation's shape (submit, then approve), not the allowance request's (ask,
-- then pay).
--
-- WHY THIS IS NOT A HOLE IN THE FLOAT CONTROL, which it superficially resembles.
-- A dispatch manager is kept out of `CAN_WRITE_SHIPMENT_MONEY` because they hold
-- trip cash and could otherwise pay themselves. That rule is about money going
-- OUT to the crew. A client's payment comes IN, reaches nobody's pocket, and is
-- unverified until accounting says otherwise.
--
-- AN UNVERIFIED PAYMENT STILL COUNTS as collected, the same call `GrossProfit`
-- makes about a running liquidation: money a client demonstrably sent does not
-- become less sent while it waits for a tick. A RETURNED one does not count —
-- somebody looked and stated they could not match it, which is a different
-- thing from nobody having looked.

ALTER TABLE "client_payment"
  ADD COLUMN "verificationStatus" SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN "verifiedBy" UUID,
  ADD COLUMN "verifiedAt" TIMESTAMPTZ(6),
  ADD COLUMN "verificationNote" TEXT;

-- DEFAULT 1 (UNVERIFIED) rather than 2, which matters only for the rows that
-- already exist: every payment recorded before this migration was recorded by
-- ADMINISTRATOR or ACCOUNTING, since nobody else could, so calling them
-- unverified understates them. It is still the right default — "verified" is a
-- claim that a named person checked something on a named date, and there is no
-- honest value to backfill `verifiedBy` and `verifiedAt` with. An accountant
-- ticking a handful of historic rows is a minute's work; a row asserting a
-- verification that never happened is permanent.

CREATE INDEX "client_payment_verificationStatus_idx"
  ON "client_payment"("verificationStatus");

ALTER TABLE "client_payment" ADD CONSTRAINT "client_payment_verifiedBy_fkey"
  FOREIGN KEY ("verifiedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Code set: PaymentVerificationStatus (1 UNVERIFIED, 2 VERIFIED, 3 RETURNED).
ALTER TABLE client_payment ADD CONSTRAINT client_payment_verification_status_code_valid
  CHECK (("verificationStatus" = ANY (ARRAY[1, 2, 3])));

-- THE VERIFICATION SHAPE, in the database rather than only in the service.
--
--   UNVERIFIED (1)  nothing checked: no verifier, no timestamp, no note. A row
--                   claiming to be unchecked while naming who checked it is a
--                   record nobody can interpret.
--   VERIFIED (2)    checked, and MUST name who and when — that is the entire
--                   content of the claim. No note: it matched, and an empty box
--                   beside every confirmed payment dilutes the one that says
--                   something.
--   RETURNED (3)    checked, MUST name who and when, and MUST say why. A return
--                   with no reason is whoever recorded it being told to look
--                   again with no idea what to look for — the same argument, and
--                   the same word, as returning a liquidation to the crew.
--
-- One constraint rather than four, because they are one rule: what a completed
-- check looks like. Split up, a later status could satisfy every clause
-- individually and none of them together.
ALTER TABLE client_payment ADD CONSTRAINT client_payment_verification_matches_status
  CHECK (
    CASE "verificationStatus"
      WHEN 1 THEN ("verifiedBy" IS NULL AND "verifiedAt" IS NULL AND "verificationNote" IS NULL)
      WHEN 2 THEN ("verifiedBy" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationNote" IS NULL)
      WHEN 3 THEN ("verifiedBy" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "verificationNote" IS NOT NULL)
      ELSE false
    END
  );

COMMENT ON COLUMN client_payment."verificationStatus" IS
  'Code set: PaymentVerificationStatus (1 UNVERIFIED, 2 VERIFIED, 3 RETURNED). Order comes from the declared sequence in @eztruckr/types, never from the number. UNVERIFIED still counts as collected; RETURNED does not.';
COMMENT ON COLUMN client_payment."verifiedBy" IS
  'The accountant who performed the check. Present on RETURNED as well as VERIFIED — it names who looked, not that they found it, which is who whoever recorded it has to go and ask.';
COMMENT ON COLUMN client_payment."verificationNote" IS
  'Why accounting could not match the payment. Required on a return and forbidden otherwise, by client_payment_verification_matches_status.';
