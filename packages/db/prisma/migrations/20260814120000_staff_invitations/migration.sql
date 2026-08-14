-- Staff invitations: a provisioned login is taken up by its owner, never
-- handed over with a password an administrator chose.
--
-- The second migration in the tree. `00000000000000_init` stays the baseline it
-- became when primary keys changed type; it is not edited for new work, because
-- its sections 2-5 are hand-assembled and regenerating them drops every
-- guarantee the database enforces.

-- --------------------------------------------------------------------------
-- 1. Table, indexes and foreign keys (from `prisma migrate diff`)
-- --------------------------------------------------------------------------

CREATE TABLE "staff_invitation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(6),
    "revokedAt" TIMESTAMPTZ(6),
    "sentAt" TIMESTAMPTZ(6),
    "deliveryError" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "staff_invitation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "staff_invitation_userId_idx" ON "staff_invitation"("userId");
CREATE INDEX "staff_invitation_deletedAt_idx" ON "staff_invitation"("deletedAt");

ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --------------------------------------------------------------------------
-- 2. CHECKs — the house conventions, plus the two rules of this table
-- --------------------------------------------------------------------------

ALTER TABLE staff_invitation ADD CONSTRAINT staff_invitation_created_by_required
  CHECK (("createdBy" IS NOT NULL));
ALTER TABLE staff_invitation ADD CONSTRAINT staff_invitation_soft_delete_consistent
  CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));

-- An invite is taken up or withdrawn, never both. Without this the accept path
-- and the revoke path could each write their own column over a row the other
-- had already closed, and `status` would depend on which was read first.
ALTER TABLE staff_invitation ADD CONSTRAINT staff_invitation_outcome_exclusive
  CHECK (NOT (("acceptedAt" IS NOT NULL) AND ("revokedAt" IS NOT NULL)));

-- Delivery either succeeded at a time or failed with a reason. Both null means
-- it has not been attempted; both set would be a row claiming both outcomes.
ALTER TABLE staff_invitation ADD CONSTRAINT staff_invitation_delivery_exclusive
  CHECK (NOT (("sentAt" IS NOT NULL) AND ("deliveryError" IS NOT NULL)));

-- --------------------------------------------------------------------------
-- 3. Partial uniques (Prisma cannot express a WHERE clause on an index)
-- --------------------------------------------------------------------------

-- One token, one invitation. Hashes collide only if SHA-256 does, but a unique
-- index is what makes "look the token up" a single-row read by definition
-- rather than by trust in the generator.
CREATE UNIQUE INDEX staff_invitation_token_live_key
  ON staff_invitation USING btree ("tokenHash") WHERE ("deletedAt" IS NULL);

-- AT MOST ONE PENDING INVITE PER LOGIN. This is the constraint that makes
-- "resend" honest: it must revoke the outstanding row before inserting a new
-- one, so two links for the same account can never both be live and the older
-- email cannot be used after the newer one was sent.
CREATE UNIQUE INDEX staff_invitation_pending_user_live_key
  ON staff_invitation USING btree ("userId")
  WHERE (("deletedAt" IS NULL) AND ("acceptedAt" IS NULL) AND ("revokedAt" IS NULL));

-- --------------------------------------------------------------------------
-- 4. Column comments
-- --------------------------------------------------------------------------

COMMENT ON COLUMN staff_invitation."tokenHash" IS
  'SHA-256 (hex) of the invite token. The plaintext exists only in the email that carried it.';
COMMENT ON COLUMN staff_invitation."acceptedAt" IS
  'When the invitee set their password. Mutually exclusive with revokedAt.';
COMMENT ON COLUMN staff_invitation."revokedAt" IS
  'When an administrator withdrew the invite. Mutually exclusive with acceptedAt.';
COMMENT ON COLUMN staff_invitation."deliveryError" IS
  'Why the mail transport refused. Mutually exclusive with sentAt; a failed send leaves the invitation valid.';
