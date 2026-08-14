-- When the system was first set up, and by extension whether it has been.
--
-- `POST /system/initialize` is a PUBLIC endpoint that creates the first
-- administrator. It has to be public — there is nobody to authenticate as
-- before it runs — so the only thing standing between a stranger and an
-- administrator account is this column being non-null.
--
-- WHY IT IS STORED RATHER THAN DERIVED. "Initialised" could be read as "an
-- administrator exists", and that would be wrong in a dangerous way: removing
-- or deactivating the last administrator would reopen a public
-- administrator-creation endpoint. Once set, this is never cleared.
--
-- WHY IT MAKES INITIALISATION ATOMIC. The row is a singleton, so two concurrent
-- requests both run `UPDATE ... WHERE "initializedAt" IS NULL` against the same
-- row; Postgres serialises them and the second updates nothing. The service
-- reads the affected count and the loser is refused. No advisory lock needed.

ALTER TABLE "system_setting" ADD COLUMN "initializedAt" TIMESTAMPTZ(6);

COMMENT ON COLUMN system_setting."initializedAt" IS
  'When the first administrator was created. Non-null closes the public /system/initialize endpoint permanently.';

-- Any database that already has an administrator was set up before this column
-- existed — through the seed, or by hand. Marking those initialised keeps the
-- public endpoint closed on them, which is the safe direction: the alternative
-- leaves a live system briefly offering to create a second first-administrator.
UPDATE "system_setting"
   SET "initializedAt" = now()
 WHERE "initializedAt" IS NULL
   AND EXISTS (SELECT 1 FROM "user" WHERE role = 1 AND "deletedAt" IS NULL);
