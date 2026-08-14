-- An email address on the staff record.
--
-- NULLABLE, and not unique. A driver may have no email at all, and two people
-- can legitimately share one — a household address, or a depot mailbox. This is
-- contact detail, not a credential.
--
-- It is deliberately NOT a foreign key to, or a mirror of, `user.email`:
--   - `user.email` is the login. It is partial-unique, Better Auth owns it, and
--     changing it changes which account exists.
--   - `staff.email` is where you write to this person.
-- A staff member may have no login, a login may belong to office staff with no
-- staff row, and correcting a typo in someone's contact details must never
-- silently move an account. Two columns, two jobs.

ALTER TABLE "staff" ADD COLUMN "email" TEXT;

COMMENT ON COLUMN staff."email" IS
  'Contact address for the person. Not the login — see user.email — and neither unique nor required.';
