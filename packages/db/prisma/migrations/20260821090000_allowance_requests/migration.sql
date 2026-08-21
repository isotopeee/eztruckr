-- Dispatch asking accounting for a trip's cash, and what accounting decided.
--
-- WHAT THIS FIXES. Releasing cash is `CAN_WRITE_SHIPMENT_MONEY` — accounting
-- and the administrator, and both dispatch roles are excluded deliberately,
-- because a dispatch manager holds trip floats and could otherwise pay
-- themselves. The consequence was that the person who KNOWS the truck leaves
-- at five had no way to say so inside the system, and the ask happened in a
-- chat thread. A release nobody could account for then looked exactly like a
-- release nobody had asked for.
--
-- ONE NEW TABLE AND NOTHING ELSE MOVES. An approved request produces an
-- ordinary `allowance` row, on the ordinary account, counted in the ordinary
-- total advanced. `allowance` gains no column: the join lives here, on
-- `allowanceId`, so nothing that reads trip cash has to learn this table
-- exists.

-- CreateTable
CREATE TABLE "allowance_request" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "liquidationId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "purpose" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "requestedBy" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMPTZ(6),
    "decisionReason" TEXT,
    "allowanceId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "allowance_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "allowance_request_shipmentId_idx" ON "allowance_request"("shipmentId");
CREATE INDEX "allowance_request_liquidationId_idx" ON "allowance_request"("liquidationId");
CREATE INDEX "allowance_request_staffId_idx" ON "allowance_request"("staffId");
CREATE INDEX "allowance_request_requestedBy_idx" ON "allowance_request"("requestedBy");
-- The cross-trip queue is "every request at one status", so the status column
-- is the one this table is actually searched by.
CREATE INDEX "allowance_request_status_idx" ON "allowance_request"("status");
CREATE INDEX "allowance_request_deletedAt_idx" ON "allowance_request"("deletedAt");

-- AddForeignKey
--
-- The liquidation key is COMPOSITE, `(liquidationId, shipmentId)` against
-- `liquidation (id, shipmentId)`, exactly as `allowance` does it. That is why
-- `shipmentId` is carried here rather than reached through the liquidation:
-- the redundancy is what makes "an ask names an account on its own trip" a
-- fact the database checks instead of one a service remembers.

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_shipmentId_fkey"
  FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_liquidationId_shipmentId_fkey"
  FOREIGN KEY ("liquidationId", "shipmentId") REFERENCES "liquidation"("id", "shipmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_staffId_fkey"
  FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_requestedBy_fkey"
  FOREIGN KEY ("requestedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_decidedBy_fkey"
  FOREIGN KEY ("decidedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RESTRICT, not SET NULL, and this one differs from every other receipt-shaped
-- link in the schema on purpose. The decision CHECK below requires this column
-- on an approved row, so nulling it out would leave a row the database itself
-- refuses. Releases are soft-deleted, so the link stays readable while the
-- allowance's own removal records that the cash came back off the account.
ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_allowanceId_fkey"
  FOREIGN KEY ("allowanceId") REFERENCES "allowance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_createdBy_fkey"
  FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_updatedBy_fkey"
  FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "allowance_request" ADD CONSTRAINT "allowance_request_deletedBy_fkey"
  FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The house constraints, in the same shape as every other business table.

ALTER TABLE allowance_request ADD CONSTRAINT allowance_request_amount_positive
  CHECK ((amount > (0)::numeric));

ALTER TABLE allowance_request ADD CONSTRAINT allowance_request_created_by_required
  CHECK (("createdBy" IS NOT NULL));

ALTER TABLE allowance_request ADD CONSTRAINT allowance_request_soft_delete_consistent
  CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));

-- Code set: AllowanceRequestStatus (1 PENDING, 2 APPROVED, 3 DECLINED).
-- `code-constraints.test.ts` reads this back out of the catalog and compares it
-- against the TypeScript declaration, so appending a code without widening this
-- fails the build rather than the write.
ALTER TABLE allowance_request ADD CONSTRAINT allowance_request_status_code_valid
  CHECK ((status = ANY (ARRAY[1, 2, 3])));

-- THE DECISION SHAPE, in the database rather than only in the service.
--
--   PENDING (1)   nothing decided: no decider, no timestamp, no reason, and
--                 above all no release. A pending ask that already names an
--                 allowance is cash that left before anybody approved it.
--   APPROVED (2)  decided, and MUST name the release it produced. Without this
--                 clause an approved request could point at nothing, which is a
--                 record of cash authorised and then untraceable.
--   DECLINED (3)  decided, MUST say why, and MUST NOT name a release. A refusal
--                 with no reason is dispatch being told to try again with no
--                 idea what to change — the same argument that makes a
--                 liquidation's return reason mandatory.
--
-- Written as one constraint rather than four because they are one rule: what a
-- decision looks like. Split up, a later status could satisfy every clause
-- individually and none of them together.
ALTER TABLE allowance_request ADD CONSTRAINT allowance_request_decision_matches_status
  CHECK (
    CASE status
      WHEN 1 THEN ("decidedBy" IS NULL AND "decidedAt" IS NULL AND "decisionReason" IS NULL AND "allowanceId" IS NULL)
      WHEN 2 THEN ("decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionReason" IS NULL AND "allowanceId" IS NOT NULL)
      WHEN 3 THEN ("decidedBy" IS NOT NULL AND "decidedAt" IS NOT NULL AND "decisionReason" IS NOT NULL AND "allowanceId" IS NULL)
      ELSE false
    END
  );

-- ONE LIVE REQUEST PER RELEASE. Partial, like every unique index here: a
-- removed request releases its claim, so a release whose request was withdrawn
-- and re-raised is not permanently unclaimable. What it refuses is two live
-- requests both saying they produced the same allowance, which would let one
-- ask be answered with another's money.
CREATE UNIQUE INDEX allowance_request_allowance_live_key
  ON public.allowance_request USING btree ("allowanceId")
  WHERE (("deletedAt" IS NULL) AND ("allowanceId" IS NOT NULL));

-- Comments, so somebody reading raw SQL can decode the columns that are not
-- self-evident. The code-set comment is asserted by code-constraints.test.ts.

COMMENT ON COLUMN allowance_request."status" IS
  'Code set: AllowanceRequestStatus (1 PENDING, 2 APPROVED, 3 DECLINED). Order comes from the declared sequence in @eztruckr/types, never from the number.';
COMMENT ON COLUMN allowance_request."purpose" IS
  'What the cash is for, in the requester''s words. NOT NULL, unlike every other free-text column here: it is the content of the ask, and it is what accounting decides on.';
COMMENT ON COLUMN allowance_request."requestedBy" IS
  'The user who asked for the cash. Distinct from createdBy for the same reason as allowance.releasedBy — the person who decides a truck needs money and the person who types it in need not be the same one.';
COMMENT ON COLUMN allowance_request."decisionReason" IS
  'Why accounting refused. Required on a decline and forbidden otherwise, by allowance_request_decision_matches_status.';
COMMENT ON COLUMN allowance_request."allowanceId" IS
  'The release an approval produced. Non-null exactly when the request is approved, which allowance_request_decision_matches_status enforces rather than trusts.';
