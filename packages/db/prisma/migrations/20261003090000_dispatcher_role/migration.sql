-- DISPATCHER (7): dispatches like a dispatch manager, with no access to trip
-- cash or margin. Not linked to a staff row, so nothing else changes here.

ALTER TABLE "user" DROP CONSTRAINT user_role_code_valid;

ALTER TABLE "user" ADD CONSTRAINT user_role_code_valid
  CHECK ((role = ANY (ARRAY[1, 2, 3, 4, 5, 6, 7])));
