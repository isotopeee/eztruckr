-- Dispatchers hold trip cash, and the rate chain becomes correctable.
--
-- Three changes that arrived together because they are one policy decision:
--
--   1. `StaffRole` gains DISPATCHER (4), so the office role that books trips
--      can also be named custodian of one's float. The existing DISPATCH_MANAGER
--      (3) was the only way to say "may hold cash without being on the truck",
--      and using it for dispatchers would have handed every dispatcher the
--      wider master data that role carries.
--   2. Every live OPERATIONS login is given the `staff` row it now requires.
--      "Their own float" cannot mean anything until the login resolves to a
--      person, which is the same reason CREW and DISPATCH_MANAGER already
--      carry the link.
--   3. `shipment.rateChainUpdatedAt` records when the gross rate or the broker
--      cut last moved. The rate chain used to be frozen at dispatch, so a
--      computed commission could not fall behind it; now that administrators
--      and dispatch managers may correct it, `isComputationStale` needs
--      something to compare against — and comparing `updatedAt` would call a
--      commission stale because somebody swapped the truck.

-- 1 ------------------------------------------------------------------------

ALTER TABLE staff DROP CONSTRAINT staff_eligible_roles_valid;

ALTER TABLE staff ADD CONSTRAINT staff_eligible_roles_valid
  CHECK ((("eligibleRoles" IS NULL) OR ("eligibleRoles" <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint, (4)::smallint])));

COMMENT ON COLUMN staff."eligibleRoles" IS
  'Code set StaffRole (@eztruckr/types): 1 DRIVER, 2 HELPER, 3 DISPATCH_MANAGER, 4 DISPATCHER. Roles this person MAY fill; the role actually filled on a trip is recorded on commission.role, which permits only the crew subset (1, 2). 3 and 4 may hold a trip''s cash without occupying a slot on it.';

-- 2 ------------------------------------------------------------------------
--
-- The name is split on the first space, which is the only split the data
-- supports: `user.name` is one field. A one-word name leaves `lastName` empty
-- rather than guessing, and both halves are the person's to correct on the
-- staff screen afterwards.
--
-- `createdBy` names the login itself. The row exists because that login does,
-- and attributing it to whichever administrator happens to run the migration
-- would be a claim about who hired somebody.

WITH unlinked AS (
  SELECT u.id,
         COALESCE(NULLIF(split_part(u.name, ' ', 1), ''), u.email) AS first_name,
         COALESCE(NULLIF(substring(u.name FROM position(' ' IN u.name) + 1), u.name), '') AS last_name
    FROM "user" u
   WHERE u.role = 2
     AND u."staffId" IS NULL
     AND u."deletedAt" IS NULL
), created AS (
  INSERT INTO staff (id, "firstName", "lastName", "isActive", "eligibleRoles", "createdAt", "updatedAt", "createdBy")
  SELECT uuidv7(), unlinked.first_name, unlinked.last_name, TRUE, ARRAY[(4)::smallint], NOW(), NOW(), unlinked.id
    FROM unlinked
  RETURNING id, "createdBy" AS user_id
)
UPDATE "user"
   SET "staffId" = created.id
  FROM created
 WHERE "user".id = created.user_id;

COMMENT ON COLUMN "user"."staffId" IS
  'Which staff member this login belongs to. Required for CREW, OPERATIONS and DISPATCH_MANAGER — the three roles that hold trip cash — and forbidden for every other role. A crew login is SCOPED by it; the two office roles are not, and carry it so their own floats can be told apart from everyone else''s.';

-- 3 ------------------------------------------------------------------------

ALTER TABLE shipment ADD COLUMN "rateChainUpdatedAt" TIMESTAMPTZ(6);

COMMENT ON COLUMN shipment."rateChainUpdatedAt" IS
  'When the gross rate or the broker cut was last corrected after booking. Null while they still stand as booked. Compared against commissionsComputedAt to report a computation as stale.';
