-- OPERATIONS (2) is retired; its logins become DISPATCHER (7).
--
-- DISPATCHER now holds a float, so it is a linked role like CREW and
-- DISPATCH_MANAGER: every live login of either code must resolve to a staff
-- row that may hold trip cash. OPERATIONS logins were linked by
-- 20260815200000_dispatcher_cash_custody; DISPATCHER logins created since
-- 20261003090000_dispatcher_role were not, because the role was unlinked then.
--
-- The code itself is never reused. The CHECK below stops anything writing it.

-- 1. Give every live, unlinked login of either code its staff row ------------
--
-- The same split and attribution as the cash-custody migration: the name is
-- split on its first space, and `createdBy` names the login itself.

WITH unlinked AS (
  SELECT u.id,
         COALESCE(NULLIF(split_part(u.name, ' ', 1), ''), u.email) AS first_name,
         COALESCE(NULLIF(substring(u.name FROM position(' ' IN u.name) + 1), u.name), '') AS last_name
    FROM "user" u
   WHERE u.role IN (2, 7)
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

-- 2. Every linked staff row may hold cash as a dispatcher ---------------------
--
-- A login whose person is not eligible could be confined to its own float and
-- never be given one.

UPDATE staff
   SET "eligibleRoles" = array_append(COALESCE("eligibleRoles", ARRAY[]::smallint[]), (4)::smallint),
       "updatedAt" = NOW()
 WHERE id IN (SELECT "staffId" FROM "user" WHERE role IN (2, 7) AND "staffId" IS NOT NULL)
   AND NOT ((4)::smallint = ANY (COALESCE("eligibleRoles", ARRAY[]::smallint[])));

-- 3. Move the logins, then refuse the code -----------------------------------

UPDATE "user" SET role = 7 WHERE role = 2;

ALTER TABLE "user" DROP CONSTRAINT user_role_code_valid;

ALTER TABLE "user" ADD CONSTRAINT user_role_code_valid
  CHECK ((role = ANY (ARRAY[1, 3, 4, 5, 6, 7])));

COMMENT ON COLUMN "user"."staffId" IS
  'Which staff member this login belongs to. Required for CREW, DISPATCH_MANAGER and DISPATCHER — the roles that hold trip cash — and forbidden for every other role. CREW and DISPATCHER see only the floats they are custodian of; the dispatch manager reads every account and edits only their own.';
