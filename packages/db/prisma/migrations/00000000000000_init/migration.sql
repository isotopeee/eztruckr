-- EZTruckr, from empty.
--
-- ONE MIGRATION, ON PURPOSE. The chain that preceded this was 19 migrations
-- recording how the model was found — enums collapsed to SMALLINT, crew_member
-- becoming staff, one liquidation per shipment becoming one per custodian,
-- "paid to" moving three times. None of that history is reachable any more:
-- primary keys changed type in this same change, so no earlier migration could
-- be replayed against a database this one produces. A chain whose early links
-- cannot run is a chain that only looks like provenance. The reasoning it
-- carried lives in HANDOFF.md, which is where a reader was always going to
-- find it.
--
-- Sections, in dependency order:
--   1. Tables, foreign keys and the indexes Prisma can express
--   2. Trigger functions, then the triggers that use them
--   3. CHECK constraints
--   4. Partial unique indexes
--   5. Comments
--
-- Sections 2-5 are things the Prisma schema language cannot state. They are
-- the reason this file is hand-assembled rather than generated: `prisma migrate
-- diff` produces section 1 and nothing else, so a regenerated migration would
-- silently drop every guarantee the database actually enforces.

-- ===========================================================================
-- 1. Tables, foreign keys, indexes
-- ===========================================================================
--
-- Every primary key is `uuid DEFAULT uuidv7()`. v7 is time-ordered in its
-- leading 48 bits, so inserts land at the right edge of the key's B-tree
-- rather than scattering through it — which suits a schema where every table
-- is append-mostly and soft-deleted, so the index only ever grows.
--
-- `uuidv7()` is BUILT IN TO POSTGRES 18. There is no extension to create and
-- no fallback: on an older server every CREATE TABLE below fails, which is the
-- right way to find out the image was pinned wrong.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "role" SMALLINT NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "staffId" UUID,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profile" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "userId" UUID NOT NULL,
    "displayName" TEXT,
    "phone" TEXT,
    "avatarKey" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-PH',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Manila',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "refreshTokenExpiresAt" TIMESTAMPTZ(6),
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "plateNumber" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "modelYear" INTEGER,
    "bodyType" TEXT,
    "capacityKg" DECIMAL(10,2),
    "registrationExpiry" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "staffCode" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "phone" TEXT,
    "address" TEXT,
    "dateHired" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "eligibleRoles" SMALLINT[],
    "licenseNumber" TEXT,
    "licenseExpiry" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "staff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "tin" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "third_party" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultCommissionRate" DECIMAL(5,4),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "third_party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payee" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "payeeType" SMALLINT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "tin" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "payee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "distanceKm" DECIMAL(10,2),
    "standardRate" DECIMAL(15,4),
    "standardAllowance" DECIMAL(15,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_category" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiresReceipt" BOOLEAN NOT NULL DEFAULT true,
    "requiresPayee" BOOLEAN NOT NULL DEFAULT true,
    "defaultCommissionable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 10,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "expense_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_rule" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "name" TEXT NOT NULL,
    "role" SMALLINT NOT NULL,
    "method" SMALLINT NOT NULL DEFAULT 1,
    "rate" DECIMAL(5,4),
    "fixedAmount" DECIMAL(15,4),
    "params" JSONB,
    "clientId" UUID,
    "routeId" UUID,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "commission_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "gasExpenseDeductionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.25,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Manila',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentNumber" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "clientId" UUID NOT NULL,
    "thirdPartyId" UUID,
    "routeId" UUID,
    "truckId" UUID,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "cargoDescription" TEXT,
    "driverId" UUID,
    "helperId" UUID,
    "dispatchedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "grossRate" DECIMAL(15,4) NOT NULL,
    "tpcAmount" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "netRate" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "appliedTpcRate" DECIMAL(5,4),
    "gasRateOverride" DECIMAL(5,4),
    "gasRateOverrideReason" TEXT,
    "appliedGasDeductionRate" DECIMAL(5,4),
    "commissionableCharges" DECIMAL(15,4),
    "grossForCommission" DECIMAL(15,4),
    "gasDeductionAmount" DECIMAL(15,4),
    "commissionableBase" DECIMAL(15,4),
    "commissionsComputedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowance" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "liquidationId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,
    "releasedBy" UUID NOT NULL,
    "disbursementMode" SMALLINT NOT NULL,
    "referenceNumber" TEXT,
    "receiptId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "allowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidation" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "custodianId" UUID,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "totalAllowance" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalLiquidated" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "variance" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMPTZ(6),
    "approvedAt" TIMESTAMPTZ(6),
    "approvedBy" UUID,
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "liquidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidation_history" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "liquidationId" UUID NOT NULL,
    "action" SMALLINT NOT NULL,
    "actorId" UUID NOT NULL,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "liquidation_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidation_line" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "liquidationId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,4) NOT NULL,
    "spentAt" TIMESTAMPTZ(6) NOT NULL,
    "payeeId" UUID,
    "payeeRequired" BOOLEAN NOT NULL DEFAULT true,
    "receiptId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "liquidation_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "uploadedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "liquidationId" UUID NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "amount" DECIMAL(15,4) NOT NULL,
    "disbursementMode" SMALLINT,
    "referenceNumber" TEXT,
    "receiptId" UUID,
    "settledAt" TIMESTAMPTZ(6),
    "settledBy" UUID,
    "remarks" TEXT,
    "crewDeductionId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "settlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billable_expense" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "expenseCategoryId" UUID,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "isCommissionable" BOOLEAN NOT NULL DEFAULT false,
    "receiptId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "billable_expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_paid_expense" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "expenseCategoryId" UUID NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,4) NOT NULL,
    "spentAt" TIMESTAMPTZ(6) NOT NULL,
    "payeeId" UUID,
    "payeeRequired" BOOLEAN NOT NULL DEFAULT true,
    "receiptId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "company_paid_expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "additional_charge" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "isCommissionable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "additional_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_deduction" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "staffId" UUID NOT NULL,
    "shipmentId" UUID,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "incurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "crew_deduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_deduction_recovery" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "crewDeductionId" UUID NOT NULL,
    "payoutLineId" UUID NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "crew_deduction_recovery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustment" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "staffId" UUID NOT NULL,
    "shipmentId" UUID,
    "direction" SMALLINT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedBy" UUID NOT NULL,
    "approvedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutLineId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "shipmentId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "role" SMALLINT NOT NULL,
    "appliedMethod" SMALLINT NOT NULL DEFAULT 1,
    "appliedRuleId" UUID,
    "appliedRuleName" TEXT,
    "commissionableBase" DECIMAL(15,4) NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "appliedRate" DECIMAL(9,4),
    "appliedFormulaExpression" TEXT,
    "appliedFormulaFields" JSONB,
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutLineId" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_run" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "runNumber" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "totalGross" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalAdjustments" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMPTZ(6),
    "approvedBy" UUID,
    "paidAt" TIMESTAMPTZ(6),
    "paidBy" UUID,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedBy" UUID,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "payout_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_line" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "payoutRunId" UUID NOT NULL,
    "staffId" UUID NOT NULL,
    "grossAmount" DECIMAL(15,4) NOT NULL,
    "deductionAmount" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "adjustmentAmount" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(15,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "payout_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" UUID,
    "updatedBy" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" UUID,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_role_idx" ON "user"("role");

-- CreateIndex
CREATE INDEX "user_isActive_idx" ON "user"("isActive");

-- CreateIndex
CREATE INDEX "user_deletedAt_idx" ON "user"("deletedAt");

-- CreateIndex
CREATE INDEX "user_profile_userId_idx" ON "user_profile"("userId");

-- CreateIndex
CREATE INDEX "user_profile_deletedAt_idx" ON "user_profile"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE INDEX "truck_isActive_idx" ON "truck"("isActive");

-- CreateIndex
CREATE INDEX "truck_deletedAt_idx" ON "truck"("deletedAt");

-- CreateIndex
CREATE INDEX "staff_isActive_idx" ON "staff"("isActive");

-- CreateIndex
CREATE INDEX "staff_lastName_firstName_idx" ON "staff"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "staff_deletedAt_idx" ON "staff"("deletedAt");

-- CreateIndex
CREATE INDEX "client_isActive_idx" ON "client"("isActive");

-- CreateIndex
CREATE INDEX "client_deletedAt_idx" ON "client"("deletedAt");

-- CreateIndex
CREATE INDEX "third_party_isActive_idx" ON "third_party"("isActive");

-- CreateIndex
CREATE INDEX "third_party_deletedAt_idx" ON "third_party"("deletedAt");

-- CreateIndex
CREATE INDEX "payee_isActive_idx" ON "payee"("isActive");

-- CreateIndex
CREATE INDEX "payee_deletedAt_idx" ON "payee"("deletedAt");

-- CreateIndex
CREATE INDEX "route_isActive_idx" ON "route"("isActive");

-- CreateIndex
CREATE INDEX "route_deletedAt_idx" ON "route"("deletedAt");

-- CreateIndex
CREATE INDEX "expense_category_isActive_idx" ON "expense_category"("isActive");

-- CreateIndex
CREATE INDEX "expense_category_deletedAt_idx" ON "expense_category"("deletedAt");

-- CreateIndex
CREATE INDEX "commission_rule_role_isActive_effectiveFrom_idx" ON "commission_rule"("role", "isActive", "effectiveFrom");

-- CreateIndex
CREATE INDEX "commission_rule_clientId_idx" ON "commission_rule"("clientId");

-- CreateIndex
CREATE INDEX "commission_rule_routeId_idx" ON "commission_rule"("routeId");

-- CreateIndex
CREATE INDEX "commission_rule_deletedAt_idx" ON "commission_rule"("deletedAt");

-- CreateIndex
CREATE INDEX "shipment_status_idx" ON "shipment"("status");

-- CreateIndex
CREATE INDEX "shipment_clientId_idx" ON "shipment"("clientId");

-- CreateIndex
CREATE INDEX "shipment_driverId_idx" ON "shipment"("driverId");

-- CreateIndex
CREATE INDEX "shipment_helperId_idx" ON "shipment"("helperId");

-- CreateIndex
CREATE INDEX "shipment_truckId_idx" ON "shipment"("truckId");

-- CreateIndex
CREATE INDEX "shipment_dispatchedAt_idx" ON "shipment"("dispatchedAt");

-- CreateIndex
CREATE INDEX "shipment_deletedAt_idx" ON "shipment"("deletedAt");

-- CreateIndex
CREATE INDEX "allowance_shipmentId_idx" ON "allowance"("shipmentId");

-- CreateIndex
CREATE INDEX "allowance_liquidationId_idx" ON "allowance"("liquidationId");

-- CreateIndex
CREATE INDEX "allowance_staffId_idx" ON "allowance"("staffId");

-- CreateIndex
CREATE INDEX "allowance_releasedBy_idx" ON "allowance"("releasedBy");

-- CreateIndex
CREATE INDEX "allowance_deletedAt_idx" ON "allowance"("deletedAt");

-- CreateIndex
CREATE INDEX "liquidation_shipmentId_idx" ON "liquidation"("shipmentId");

-- CreateIndex
CREATE INDEX "liquidation_custodianId_idx" ON "liquidation"("custodianId");

-- CreateIndex
CREATE INDEX "liquidation_status_idx" ON "liquidation"("status");

-- CreateIndex
CREATE INDEX "liquidation_deletedAt_idx" ON "liquidation"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "liquidation_id_shipment_key" ON "liquidation"("id", "shipmentId");

-- CreateIndex
CREATE INDEX "liquidation_history_liquidationId_occurredAt_idx" ON "liquidation_history"("liquidationId", "occurredAt");

-- CreateIndex
CREATE INDEX "liquidation_history_actorId_idx" ON "liquidation_history"("actorId");

-- CreateIndex
CREATE INDEX "liquidation_history_deletedAt_idx" ON "liquidation_history"("deletedAt");

-- CreateIndex
CREATE INDEX "liquidation_line_liquidationId_idx" ON "liquidation_line"("liquidationId");

-- CreateIndex
CREATE INDEX "liquidation_line_expenseCategoryId_idx" ON "liquidation_line"("expenseCategoryId");

-- CreateIndex
CREATE INDEX "liquidation_line_payeeId_idx" ON "liquidation_line"("payeeId");

-- CreateIndex
CREATE INDEX "liquidation_line_deletedAt_idx" ON "liquidation_line"("deletedAt");

-- CreateIndex
CREATE INDEX "receipt_deletedAt_idx" ON "receipt"("deletedAt");

-- CreateIndex
CREATE INDEX "settlement_shipmentId_idx" ON "settlement"("shipmentId");

-- CreateIndex
CREATE INDEX "settlement_liquidationId_idx" ON "settlement"("liquidationId");

-- CreateIndex
CREATE INDEX "settlement_status_idx" ON "settlement"("status");

-- CreateIndex
CREATE INDEX "settlement_crewDeductionId_idx" ON "settlement"("crewDeductionId");

-- CreateIndex
CREATE INDEX "settlement_deletedAt_idx" ON "settlement"("deletedAt");

-- CreateIndex
CREATE INDEX "billable_expense_shipmentId_idx" ON "billable_expense"("shipmentId");

-- CreateIndex
CREATE INDEX "billable_expense_deletedAt_idx" ON "billable_expense"("deletedAt");

-- CreateIndex
CREATE INDEX "company_paid_expense_shipmentId_idx" ON "company_paid_expense"("shipmentId");

-- CreateIndex
CREATE INDEX "company_paid_expense_expenseCategoryId_idx" ON "company_paid_expense"("expenseCategoryId");

-- CreateIndex
CREATE INDEX "company_paid_expense_payeeId_idx" ON "company_paid_expense"("payeeId");

-- CreateIndex
CREATE INDEX "company_paid_expense_deletedAt_idx" ON "company_paid_expense"("deletedAt");

-- CreateIndex
CREATE INDEX "additional_charge_shipmentId_idx" ON "additional_charge"("shipmentId");

-- CreateIndex
CREATE INDEX "additional_charge_deletedAt_idx" ON "additional_charge"("deletedAt");

-- CreateIndex
CREATE INDEX "crew_deduction_staffId_idx" ON "crew_deduction"("staffId");

-- CreateIndex
CREATE INDEX "crew_deduction_deletedAt_idx" ON "crew_deduction"("deletedAt");

-- CreateIndex
CREATE INDEX "crew_deduction_recovery_crewDeductionId_idx" ON "crew_deduction_recovery"("crewDeductionId");

-- CreateIndex
CREATE INDEX "crew_deduction_recovery_payoutLineId_idx" ON "crew_deduction_recovery"("payoutLineId");

-- CreateIndex
CREATE INDEX "crew_deduction_recovery_deletedAt_idx" ON "crew_deduction_recovery"("deletedAt");

-- CreateIndex
CREATE INDEX "adjustment_staffId_idx" ON "adjustment"("staffId");

-- CreateIndex
CREATE INDEX "adjustment_shipmentId_idx" ON "adjustment"("shipmentId");

-- CreateIndex
CREATE INDEX "adjustment_payoutLineId_idx" ON "adjustment"("payoutLineId");

-- CreateIndex
CREATE INDEX "adjustment_deletedAt_idx" ON "adjustment"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commission_payoutLineId_key" ON "commission"("payoutLineId");

-- CreateIndex
CREATE INDEX "commission_shipmentId_idx" ON "commission"("shipmentId");

-- CreateIndex
CREATE INDEX "commission_staffId_idx" ON "commission"("staffId");

-- CreateIndex
CREATE INDEX "commission_appliedRuleId_idx" ON "commission"("appliedRuleId");

-- CreateIndex
CREATE INDEX "commission_deletedAt_idx" ON "commission"("deletedAt");

-- CreateIndex
CREATE INDEX "payout_run_status_idx" ON "payout_run"("status");

-- CreateIndex
CREATE INDEX "payout_run_deletedAt_idx" ON "payout_run"("deletedAt");

-- CreateIndex
CREATE INDEX "payout_line_payoutRunId_idx" ON "payout_line"("payoutRunId");

-- CreateIndex
CREATE INDEX "payout_line_staffId_idx" ON "payout_line"("staffId");

-- CreateIndex
CREATE INDEX "payout_line_deletedAt_idx" ON "payout_line"("deletedAt");

-- CreateIndex
CREATE INDEX "audit_log_entityType_entityId_idx" ON "audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_idx" ON "audit_log"("actorId");

-- CreateIndex
CREATE INDEX "audit_log_occurredAt_idx" ON "audit_log"("occurredAt");

-- CreateIndex
CREATE INDEX "audit_log_deletedAt_idx" ON "audit_log"("deletedAt");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification" ADD CONSTRAINT "verification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck" ADD CONSTRAINT "truck_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck" ADD CONSTRAINT "truck_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck" ADD CONSTRAINT "truck_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff" ADD CONSTRAINT "staff_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "third_party" ADD CONSTRAINT "third_party_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "third_party" ADD CONSTRAINT "third_party_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "third_party" ADD CONSTRAINT "third_party_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payee" ADD CONSTRAINT "payee_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payee" ADD CONSTRAINT "payee_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payee" ADD CONSTRAINT "payee_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "route" ADD CONSTRAINT "route_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_category" ADD CONSTRAINT "expense_category_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_category" ADD CONSTRAINT "expense_category_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_category" ADD CONSTRAINT "expense_category_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_rule" ADD CONSTRAINT "commission_rule_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_setting" ADD CONSTRAINT "system_setting_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_setting" ADD CONSTRAINT "system_setting_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_setting" ADD CONSTRAINT "system_setting_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_thirdPartyId_fkey" FOREIGN KEY ("thirdPartyId") REFERENCES "third_party"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "route"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_truckId_fkey" FOREIGN KEY ("truckId") REFERENCES "truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_helperId_fkey" FOREIGN KEY ("helperId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_liquidationId_shipmentId_fkey" FOREIGN KEY ("liquidationId", "shipmentId") REFERENCES "liquidation"("id", "shipmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_releasedBy_fkey" FOREIGN KEY ("releasedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_custodianId_fkey" FOREIGN KEY ("custodianId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_liquidationId_fkey" FOREIGN KEY ("liquidationId") REFERENCES "liquidation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_history" ADD CONSTRAINT "liquidation_history_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_liquidationId_fkey" FOREIGN KEY ("liquidationId") REFERENCES "liquidation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_liquidationId_shipmentId_fkey" FOREIGN KEY ("liquidationId", "shipmentId") REFERENCES "liquidation"("id", "shipmentId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_settledBy_fkey" FOREIGN KEY ("settledBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_crewDeductionId_fkey" FOREIGN KEY ("crewDeductionId") REFERENCES "crew_deduction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement" ADD CONSTRAINT "settlement_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billable_expense" ADD CONSTRAINT "billable_expense_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_payeeId_fkey" FOREIGN KEY ("payeeId") REFERENCES "payee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_paid_expense" ADD CONSTRAINT "company_paid_expense_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction_recovery" ADD CONSTRAINT "crew_deduction_recovery_crewDeductionId_fkey" FOREIGN KEY ("crewDeductionId") REFERENCES "crew_deduction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction_recovery" ADD CONSTRAINT "crew_deduction_recovery_payoutLineId_fkey" FOREIGN KEY ("payoutLineId") REFERENCES "payout_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction_recovery" ADD CONSTRAINT "crew_deduction_recovery_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction_recovery" ADD CONSTRAINT "crew_deduction_recovery_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction_recovery" ADD CONSTRAINT "crew_deduction_recovery_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_payoutLineId_fkey" FOREIGN KEY ("payoutLineId") REFERENCES "payout_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_appliedRuleId_fkey" FOREIGN KEY ("appliedRuleId") REFERENCES "commission_rule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_payoutLineId_fkey" FOREIGN KEY ("payoutLineId") REFERENCES "payout_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission" ADD CONSTRAINT "commission_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_run" ADD CONSTRAINT "payout_run_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_run" ADD CONSTRAINT "payout_run_paidBy_fkey" FOREIGN KEY ("paidBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_run" ADD CONSTRAINT "payout_run_voidedBy_fkey" FOREIGN KEY ("voidedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_run" ADD CONSTRAINT "payout_run_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_run" ADD CONSTRAINT "payout_run_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_run" ADD CONSTRAINT "payout_run_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_payoutRunId_fkey" FOREIGN KEY ("payoutRunId") REFERENCES "payout_run"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- 2. Trigger functions and triggers
-- ===========================================================================
--
-- The payout guards. A commission that has been paid cannot be deleted,
-- soft-deleted, re-pointed at another payout line, or paid twice; a paid
-- payout run is terminal; a crew deduction cannot be over-recovered. These
-- are triggers rather than service-layer checks because they protect money
-- that has already left the building, and a service can be bypassed.

-- `uuid`, not `text`. The parameter takes `commission."payoutLineId"` straight
-- from a trigger, and Postgres resolves the call by argument type — a text
-- signature simply does not match, and the guard vanishes with a "function does
-- not exist" error the first time a paid commission is touched.
CREATE OR REPLACE FUNCTION public.eztruckr_commission_is_paid(commission_payout_line_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
AS $function$
DECLARE
  run_status SMALLINT;
BEGIN
  IF commission_payout_line_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT run.status
    INTO run_status
    FROM "payout_line" line
    JOIN "payout_run" run ON run.id = line."payoutRunId"
   WHERE line.id = commission_payout_line_id;

  RETURN run_status = eztruckr_payout_status_paid();
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_commission_payout_link_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."payoutLineId" IS NOT DISTINCT FROM OLD."payoutLineId" THEN
    RETURN NEW;
  END IF;

  IF eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'commission % was paid by payout line % and cannot be re-paid',
      OLD.id, OLD."payoutLineId"
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_crew_deduction_not_over_recovered()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  debt      NUMERIC(15, 4);
  recovered NUMERIC(15, 4);
BEGIN
  SELECT "amount" INTO debt FROM "crew_deduction" WHERE id = NEW."crewDeductionId";

  SELECT COALESCE(SUM("amount"), 0)
    INTO recovered
    FROM "crew_deduction_recovery"
   WHERE "crewDeductionId" = NEW."crewDeductionId"
     AND "deletedAt" IS NULL;

  IF recovered > debt THEN
    RAISE EXCEPTION
      'crew deduction % would be over-recovered: % recovered against a debt of %',
      NEW."crewDeductionId", recovered, debt
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_commission_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'commission % belongs to a paid payout run and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_commission_no_soft_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."deletedAt" IS NULL
     AND NEW."deletedAt" IS NOT NULL
     AND eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'commission % has been paid and cannot be deleted; deleting it would free its (shipment, role) slot and allow the same work to be paid again',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_payout_line_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  owning_run_status SMALLINT;
BEGIN
  SELECT status INTO owning_run_status FROM "payout_run" WHERE id = OLD."payoutRunId";

  IF owning_run_status = eztruckr_payout_status_paid() THEN
    RAISE EXCEPTION
      'payout line % belongs to a paid run and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_payout_run_is_terminal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.status = eztruckr_payout_status_paid() AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION
      'payout run % is PAID; that status is terminal and cannot change',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.status = eztruckr_payout_status_paid()
     AND OLD."deletedAt" IS NULL
     AND NEW."deletedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'payout run % is PAID and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_recovery_is_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF eztruckr_commission_is_paid(OLD."payoutLineId")
     AND (NEW."amount" IS DISTINCT FROM OLD."amount"
          OR NEW."payoutLineId" IS DISTINCT FROM OLD."payoutLineId"
          OR NEW."crewDeductionId" IS DISTINCT FROM OLD."crewDeductionId") THEN
    RAISE EXCEPTION
      'crew deduction recovery % belongs to a paid payout run and cannot be altered',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_recovery_no_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'crew deduction recovery % belongs to a paid payout run and cannot be deleted',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_paid_recovery_no_soft_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."deletedAt" IS NULL
     AND NEW."deletedAt" IS NOT NULL
     AND eztruckr_commission_is_paid(OLD."payoutLineId") THEN
    RAISE EXCEPTION
      'crew deduction recovery % has been paid and cannot be deleted; the debt would look outstanding again and could be recovered twice',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.eztruckr_payout_status_paid()
 RETURNS smallint
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT 3::SMALLINT;
$function$;

CREATE TRIGGER commission_payout_link_is_immutable BEFORE UPDATE ON public.commission FOR EACH ROW EXECUTE FUNCTION eztruckr_commission_payout_link_is_immutable();
CREATE CONSTRAINT TRIGGER crew_deduction_recovery_not_over_recovered AFTER INSERT OR UPDATE ON public.crew_deduction_recovery DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION eztruckr_crew_deduction_not_over_recovered();
CREATE TRIGGER paid_commission_no_delete BEFORE DELETE ON public.commission FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_commission_no_delete();
CREATE TRIGGER paid_commission_no_soft_delete BEFORE UPDATE ON public.commission FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_commission_no_soft_delete();
CREATE TRIGGER paid_payout_line_no_delete BEFORE DELETE ON public.payout_line FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_payout_line_no_delete();
CREATE TRIGGER paid_payout_run_is_terminal BEFORE UPDATE ON public.payout_run FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_payout_run_is_terminal();
CREATE TRIGGER paid_recovery_is_immutable BEFORE UPDATE ON public.crew_deduction_recovery FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_recovery_is_immutable();
CREATE TRIGGER paid_recovery_no_delete BEFORE DELETE ON public.crew_deduction_recovery FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_recovery_no_delete();
CREATE TRIGGER paid_recovery_no_soft_delete BEFORE UPDATE ON public.crew_deduction_recovery FOR EACH ROW EXECUTE FUNCTION eztruckr_paid_recovery_no_soft_delete();

-- ===========================================================================
-- 3. CHECK constraints
-- ===========================================================================
--
-- Three families:
--   *_code_valid          every SMALLINT code column lists its allowed values.
--                         The values are duplicated from @eztruckr/types
--                         because SQL cannot import; code-constraints.test.ts
--                         reads them back and fails if the two drift.
--   *_created_by_required createdBy is nullable to Prisma and NOT NULL here.
--   *_soft_delete_consistent  deletedBy cannot be set without deletedAt.
--
-- Plus the domain rules: positive amounts, non-blank reasons, a crew-role
-- CHECK that stops a dispatch manager holding a commission, and the
-- payee/payeeRequired pairing.

ALTER TABLE "user" ADD CONSTRAINT user_role_code_valid CHECK ((role = ANY (ARRAY[1, 2, 3, 4, 5, 6])));
ALTER TABLE "user" ADD CONSTRAINT user_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE additional_charge ADD CONSTRAINT additional_charge_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE additional_charge ADD CONSTRAINT additional_charge_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE adjustment ADD CONSTRAINT adjustment_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE adjustment ADD CONSTRAINT adjustment_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE adjustment ADD CONSTRAINT adjustment_direction_code_valid CHECK ((direction = ANY (ARRAY[1, 2])));
ALTER TABLE adjustment ADD CONSTRAINT adjustment_reason_not_blank CHECK ((length(btrim(reason)) > 0));
ALTER TABLE adjustment ADD CONSTRAINT adjustment_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE allowance ADD CONSTRAINT allowance_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE allowance ADD CONSTRAINT allowance_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE allowance ADD CONSTRAINT allowance_disbursement_mode_code_valid CHECK (("disbursementMode" = ANY (ARRAY[1, 2, 3])));
ALTER TABLE allowance ADD CONSTRAINT allowance_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE audit_log ADD CONSTRAINT audit_log_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE audit_log ADD CONSTRAINT audit_log_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE billable_expense ADD CONSTRAINT billable_expense_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE billable_expense ADD CONSTRAINT billable_expense_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE client ADD CONSTRAINT client_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE client ADD CONSTRAINT client_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE commission ADD CONSTRAINT commission_applied_method_code_valid CHECK (("appliedMethod" = ANY (ARRAY[1, 2, 3, 4, 5])));
ALTER TABLE commission ADD CONSTRAINT commission_applied_rate_range CHECK ((("appliedRate" IS NULL) OR (("appliedRate" >= (0)::numeric) AND (("appliedMethod" <> ALL (ARRAY[1, 4])) OR ("appliedRate" <= (1)::numeric)))));
ALTER TABLE commission ADD CONSTRAINT commission_applied_rule_id_and_name_together CHECK ((("appliedRuleId" IS NULL) = ("appliedRuleName" IS NULL)));
ALTER TABLE commission ADD CONSTRAINT commission_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE commission ADD CONSTRAINT commission_formula_records_its_inputs CHECK ( CASE WHEN ("appliedMethod" = 5) THEN (("appliedFormulaExpression" IS NOT NULL) AND ("appliedFormulaFields" IS NOT NULL)) ELSE (("appliedFormulaExpression" IS NULL) AND ("appliedFormulaFields" IS NULL)) END);
ALTER TABLE commission ADD CONSTRAINT commission_rate_based_needs_rate CHECK ((("appliedMethod" <> ALL (ARRAY[1, 4])) OR ("appliedRate" IS NOT NULL)));
ALTER TABLE commission ADD CONSTRAINT commission_role_is_a_crew_role CHECK ((role = ANY (ARRAY[1, 2])));
ALTER TABLE commission ADD CONSTRAINT commission_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_effective_window_ordered CHECK ((("effectiveTo" IS NULL) OR ("effectiveFrom" < "effectiveTo")));
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_method_code_valid CHECK ((method = ANY (ARRAY[1, 2, 3, 4, 5])));
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_params_match_method CHECK ( CASE WHEN (method = 5) THEN (((params ->> 'expression'::text) IS NOT NULL) AND (length((params ->> 'expression'::text)) > 0)) ELSE (params IS NULL) END);
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_rate_range CHECK (((rate IS NULL) OR ((rate >= (0)::numeric) AND (rate <= (1)::numeric))));
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_role_is_a_crew_role CHECK ((role = ANY (ARRAY[1, 2])));
ALTER TABLE commission_rule ADD CONSTRAINT commission_rule_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE company_paid_expense ADD CONSTRAINT company_paid_expense_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE company_paid_expense ADD CONSTRAINT company_paid_expense_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE company_paid_expense ADD CONSTRAINT company_paid_expense_payee_required CHECK (((NOT "payeeRequired") OR ("payeeId" IS NOT NULL)));
ALTER TABLE company_paid_expense ADD CONSTRAINT company_paid_expense_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE crew_deduction ADD CONSTRAINT crew_deduction_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE crew_deduction ADD CONSTRAINT crew_deduction_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE crew_deduction ADD CONSTRAINT crew_deduction_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE crew_deduction_recovery ADD CONSTRAINT crew_deduction_recovery_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE crew_deduction_recovery ADD CONSTRAINT crew_deduction_recovery_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE crew_deduction_recovery ADD CONSTRAINT crew_deduction_recovery_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE expense_category ADD CONSTRAINT expense_category_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE expense_category ADD CONSTRAINT expense_category_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE liquidation ADD CONSTRAINT liquidation_approved_at_matches_status CHECK (((status = 3) = ("approvedAt" IS NOT NULL)));
ALTER TABLE liquidation ADD CONSTRAINT liquidation_approved_pair CHECK ((("approvedAt" IS NULL) = ("approvedBy" IS NULL)));
ALTER TABLE liquidation ADD CONSTRAINT liquidation_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE liquidation ADD CONSTRAINT liquidation_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE liquidation ADD CONSTRAINT liquidation_status_code_valid CHECK ((status = ANY (ARRAY[1, 2, 3])));
ALTER TABLE liquidation ADD CONSTRAINT liquidation_submitted_at_matches_status CHECK (((status = 1) OR ("submittedAt" IS NOT NULL)));
ALTER TABLE liquidation_history ADD CONSTRAINT liquidation_history_action_code_valid CHECK ((action = ANY (ARRAY[1, 2])));
ALTER TABLE liquidation_history ADD CONSTRAINT liquidation_history_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE liquidation_history ADD CONSTRAINT liquidation_history_reason_matches_action CHECK (((action = 2) = (reason IS NOT NULL)));
ALTER TABLE liquidation_history ADD CONSTRAINT liquidation_history_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE liquidation_line ADD CONSTRAINT liquidation_line_amount_positive CHECK ((amount > (0)::numeric));
ALTER TABLE liquidation_line ADD CONSTRAINT liquidation_line_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE liquidation_line ADD CONSTRAINT liquidation_line_payee_required CHECK (((NOT "payeeRequired") OR ("payeeId" IS NOT NULL)));
ALTER TABLE liquidation_line ADD CONSTRAINT liquidation_line_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE payee ADD CONSTRAINT payee_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE payee ADD CONSTRAINT payee_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE payee ADD CONSTRAINT payee_type_code_valid CHECK (("payeeType" = ANY (ARRAY[1, 2])));
ALTER TABLE payout_line ADD CONSTRAINT payout_line_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE payout_line ADD CONSTRAINT payout_line_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE payout_run ADD CONSTRAINT payout_run_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE payout_run ADD CONSTRAINT payout_run_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE payout_run ADD CONSTRAINT payout_run_status_code_valid CHECK ((status = ANY (ARRAY[1, 2, 3, 4])));
ALTER TABLE receipt ADD CONSTRAINT receipt_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE receipt ADD CONSTRAINT receipt_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE route ADD CONSTRAINT route_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE route ADD CONSTRAINT route_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE route ADD CONSTRAINT route_standard_allowance_non_negative CHECK ((("standardAllowance" IS NULL) OR ("standardAllowance" >= (0)::numeric)));
ALTER TABLE settlement ADD CONSTRAINT settlement_carry_is_a_debt CHECK ((("crewDeductionId" IS NULL) OR (amount > (0)::numeric)));
ALTER TABLE settlement ADD CONSTRAINT settlement_carry_needs_deduction CHECK (((status <> 3) OR ("crewDeductionId" IS NOT NULL)));
ALTER TABLE settlement ADD CONSTRAINT settlement_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE settlement ADD CONSTRAINT settlement_deduction_only_when_carried CHECK ((("crewDeductionId" IS NULL) OR (status = ANY (ARRAY[2, 3]))));
ALTER TABLE settlement ADD CONSTRAINT settlement_disbursement_mode_code_valid CHECK ((("disbursementMode" IS NULL) OR ("disbursementMode" = ANY (ARRAY[1, 2, 3]))));
ALTER TABLE settlement ADD CONSTRAINT settlement_movement_matches_status CHECK ( CASE WHEN (status = 2) THEN (("disbursementMode" IS NOT NULL) = ((amount <> (0)::numeric) AND ("crewDeductionId" IS NULL))) ELSE ("disbursementMode" IS NULL) END);
ALTER TABLE settlement ADD CONSTRAINT settlement_settled_at_matches_status CHECK (((status = 2) = ("settledAt" IS NOT NULL)));
ALTER TABLE settlement ADD CONSTRAINT settlement_settled_pair CHECK ((("settledAt" IS NULL) = ("settledBy" IS NULL)));
ALTER TABLE settlement ADD CONSTRAINT settlement_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE settlement ADD CONSTRAINT settlement_status_code_valid CHECK ((status = ANY (ARRAY[1, 2, 3])));
ALTER TABLE shipment ADD CONSTRAINT shipment_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE shipment ADD CONSTRAINT shipment_gas_rate_override_needs_reason CHECK ((("gasRateOverride" IS NULL) = ("gasRateOverrideReason" IS NULL)));
ALTER TABLE shipment ADD CONSTRAINT shipment_gas_rate_override_range CHECK ((("gasRateOverride" IS NULL) OR (("gasRateOverride" >= (0)::numeric) AND ("gasRateOverride" <= (1)::numeric))));
ALTER TABLE shipment ADD CONSTRAINT shipment_gas_rate_range CHECK ((("appliedGasDeductionRate" IS NULL) OR (("appliedGasDeductionRate" >= (0)::numeric) AND ("appliedGasDeductionRate" <= (1)::numeric))));
ALTER TABLE shipment ADD CONSTRAINT shipment_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE shipment ADD CONSTRAINT shipment_status_code_valid CHECK ((status = ANY (ARRAY[1, 2, 3, 4, 5, 6, 7])));
ALTER TABLE shipment ADD CONSTRAINT shipment_tpc_rate_range CHECK ((("appliedTpcRate" IS NULL) OR (("appliedTpcRate" >= (0)::numeric) AND ("appliedTpcRate" <= (1)::numeric))));
ALTER TABLE staff ADD CONSTRAINT staff_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE staff ADD CONSTRAINT staff_eligible_roles_valid CHECK ((("eligibleRoles" IS NULL) OR ("eligibleRoles" <@ ARRAY[(1)::smallint, (2)::smallint, (3)::smallint])));
ALTER TABLE staff ADD CONSTRAINT staff_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE system_setting ADD CONSTRAINT system_setting_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE system_setting ADD CONSTRAINT system_setting_rate_ranges CHECK ((("gasExpenseDeductionRate" >= (0)::numeric) AND ("gasExpenseDeductionRate" <= (1)::numeric)));
ALTER TABLE system_setting ADD CONSTRAINT system_setting_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE third_party ADD CONSTRAINT third_party_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE third_party ADD CONSTRAINT third_party_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE truck ADD CONSTRAINT truck_created_by_required CHECK (("createdBy" IS NOT NULL));
ALTER TABLE truck ADD CONSTRAINT truck_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));
ALTER TABLE user_profile ADD CONSTRAINT user_profile_soft_delete_consistent CHECK (((("deletedAt" IS NULL) AND ("deletedBy" IS NULL)) OR ("deletedAt" IS NOT NULL)));

-- ===========================================================================
-- 4. Partial unique indexes
-- ===========================================================================
--
-- `UNIQUE (...) WHERE "deletedAt" IS NULL`, which Prisma cannot express.
-- Soft-deleting a row releases its slot: a code can be reused, a shipment
-- re-liquidated, a crew member given a replacement login. A full unique index
-- would type cleanly as one-to-one and then block the slot for ever.

CREATE UNIQUE INDEX allowance_receipt_live_key ON public.allowance USING btree ("receiptId") WHERE (("deletedAt" IS NULL) AND ("receiptId" IS NOT NULL));
CREATE UNIQUE INDEX billable_expense_receipt_live_key ON public.billable_expense USING btree ("receiptId") WHERE (("deletedAt" IS NULL) AND ("receiptId" IS NOT NULL));
CREATE UNIQUE INDEX client_code_live_key ON public.client USING btree (code) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX commission_shipment_role_live_key ON public.commission USING btree ("shipmentId", role) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX company_paid_expense_receipt_live_key ON public.company_paid_expense USING btree ("receiptId") WHERE (("deletedAt" IS NULL) AND ("receiptId" IS NOT NULL));
CREATE UNIQUE INDEX crew_deduction_recovery_deduction_line_live_key ON public.crew_deduction_recovery USING btree ("crewDeductionId", "payoutLineId") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX expense_category_code_live_key ON public.expense_category USING btree (code) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX liquidation_line_receipt_live_key ON public.liquidation_line USING btree ("receiptId") WHERE (("deletedAt" IS NULL) AND ("receiptId" IS NOT NULL));
CREATE UNIQUE INDEX liquidation_shipment_custodian_live_key ON public.liquidation USING btree ("shipmentId", "custodianId") NULLS NOT DISTINCT WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX payee_code_live_key ON public.payee USING btree (code) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX payout_run_number_live_key ON public.payout_run USING btree ("runNumber") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX receipt_storage_key_live_key ON public.receipt USING btree ("storageKey") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX route_code_live_key ON public.route USING btree (code) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX settlement_crew_deduction_live_key ON public.settlement USING btree ("crewDeductionId") WHERE (("deletedAt" IS NULL) AND ("crewDeductionId" IS NOT NULL));
CREATE UNIQUE INDEX settlement_liquidation_live_key ON public.settlement USING btree ("liquidationId") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX settlement_receipt_live_key ON public.settlement USING btree ("receiptId") WHERE (("deletedAt" IS NULL) AND ("receiptId" IS NOT NULL));
CREATE UNIQUE INDEX shipment_number_live_key ON public.shipment USING btree ("shipmentNumber") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX staff_code_live_key ON public.staff USING btree ("staffCode") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX third_party_code_live_key ON public.third_party USING btree (code) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX truck_plate_number_live_key ON public.truck USING btree ("plateNumber") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX user_email_live_key ON public."user" USING btree (email) WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX user_profile_user_live_key ON public.user_profile USING btree ("userId") WHERE ("deletedAt" IS NULL);
CREATE UNIQUE INDEX user_staff_live_key ON public."user" USING btree ("staffId") WHERE (("deletedAt" IS NULL) AND ("staffId" IS NOT NULL));

-- ===========================================================================
-- 5. Comments
-- ===========================================================================
--
-- Every code column names its code set, so somebody reading raw SQL can
-- decode a 3. code-constraints.test.ts asserts the comments exist.

COMMENT ON TABLE crew_deduction_recovery IS 'One slice of a crew deduction recovered by one payout line. A deduction is divisible, unlike a commission, so recovery is a set of rows rather than a single link.';
COMMENT ON TABLE crew_deduction IS 'A charge against a crew member, recovered at payout. Holds no payout link of its own: recovery is divisible across runs, so it lives in crew_deduction_recovery. Outstanding balance = amount less the sum of live recoveries.';
COMMENT ON TABLE payee IS 'Someone OUTSIDE the company that money is disbursed to. Distinct from third_party, whose cut is netted off the gross rate and never disbursed, and from staff, who receive allowances they must liquidate.';

COMMENT ON COLUMN adjustment.amount IS 'A positive magnitude. Never an edit to Commission.amount — that row is self-verifying (base x rate = amount) and an adjustment written into it would break the property that makes a payout defensible.';
COMMENT ON COLUMN adjustment.direction IS 'Code set AdjustmentDirection (@eztruckr/types): 1 INCREASE, 2 DECREASE. Carries the sign; amount is always positive.';
COMMENT ON COLUMN adjustment."payoutLineId" IS 'Set when a payout run picks this up, and the lock: a paid adjustment can no longer be edited or removed, exactly as a paid commission cannot.';
COMMENT ON COLUMN adjustment.reason IS 'Required and non-blank. The whole point of the record: an unexplained change to somebody''s pay cannot be told apart from a mistake.';
COMMENT ON COLUMN adjustment."shipmentId" IS 'The trip this adjusts pay for, or NULL for a standing adjustment against the crew member. Deliberately not a commission id: recomputation soft-deletes and recreates commissions, so that link would dangle.';
COMMENT ON COLUMN allowance."disbursementMode" IS 'Code set DisbursementMode (@eztruckr/types): 1 CASH, 2 BANK_TRANSFER, 3 EWALLET. How this release physically moved.';
COMMENT ON COLUMN allowance."liquidationId" IS 'Which custodian''s account this release is booked against, and therefore whose variance it moves. Composite FK with shipmentId, so it can never name an account on another trip.';
COMMENT ON COLUMN allowance."referenceNumber" IS 'Bank or wallet reference. Optional for every mode including transfers: a required field is answered with "N/A", which looks like evidence and is not.';
COMMENT ON COLUMN allowance."releasedBy" IS 'The user who handed over the cash. Deliberately NOT createdBy, which is whoever typed the row in — a supervisor releases in the yard and a clerk records it later, and the voucher names the first.';
COMMENT ON COLUMN commission."appliedFormulaExpression" IS 'FORMULA only. The expression as it stood when this row was computed, frozen so a later edit to the rule cannot make the amount unreproducible.';
COMMENT ON COLUMN commission."appliedFormulaFields" IS 'FORMULA only. The catalog field values the expression actually read, e.g. {"net_rate":"16200.0000"}. With the expression, enough to recompute the amount by hand.';
COMMENT ON COLUMN commission."appliedMethod" IS 'Code set CommissionMethod (@eztruckr/types): 1 PERCENT_OF_BASE, 2 FIXED_PER_TRIP, 3 FIXED_PER_ROUTE, 4 PERCENT_OF_NET_RATE, 5 FORMULA. Frozen at computation so the row stays interpretable if the rule changes method later.';
COMMENT ON COLUMN commission."appliedRate" IS 'The rate this commission was computed at (PERCENT_OF_BASE, PERCENT_OF_NET_RATE) or reports at (the fixed and formula methods, where it is derived as amount over base purely for vouchers). Nullable: null means no meaningful rate exists, never that nothing was earned.';
COMMENT ON COLUMN commission."appliedRuleId" IS 'The CommissionRule that produced this commission. Null only on rows computed before this column existed — never backfilled, because resolution depends on rules and dates as they were.';
COMMENT ON COLUMN commission."appliedRuleName" IS 'The rule name as it read at computation, frozen so a later rename cannot relabel an old voucher. Always set together with appliedRuleId.';
COMMENT ON COLUMN commission.role IS 'Code set CrewRole (@eztruckr/types): 1 DRIVER, 2 HELPER. The role actually filled on this trip.';
COMMENT ON COLUMN commission_rule.method IS 'Code set CommissionMethod (@eztruckr/types): 1 PERCENT_OF_BASE, 2 FIXED_PER_TRIP, 3 FIXED_PER_ROUTE, 4 PERCENT_OF_NET_RATE, 5 FORMULA.';
COMMENT ON COLUMN commission_rule.params IS 'Structured configuration for methods that need more than one column. FORMULA stores {"expression": "..."} over the field catalog in @eztruckr/types. Parsed and validated before the row is written; never evaluated with eval/Function/vm.';
COMMENT ON COLUMN commission_rule.role IS 'Code set CrewRole (@eztruckr/types): 1 DRIVER, 2 HELPER.';
COMMENT ON COLUMN company_paid_expense.amount IS 'A cost of the trip that the company settled directly. Recognised in the P&L when recorded — unlike a liquidation line, there is no approval to wait for, because the money left before the row was typed.';
COMMENT ON COLUMN company_paid_expense."expenseCategoryId" IS 'Required, unlike a billable expense''s. This row exists to be a cost in the P&L and an uncategorised cost is one nobody can report on.';
COMMENT ON COLUMN company_paid_expense."payeeId" IS 'Who the company paid. Required exactly when payeeRequired is true, enforced by company_paid_expense_payee_required.';
COMMENT ON COLUMN company_paid_expense."payeeRequired" IS 'Copied from the expense category when the row was written. Frozen for the same reason as liquidation_line.payeeRequired.';
COMMENT ON COLUMN company_paid_expense."spentAt" IS 'When the money left, which is not when the row was typed. Separate from createdAt for the same reason allowance.issuedAt is.';
COMMENT ON COLUMN crew_deduction_recovery.amount IS 'Money. Always positive; the sum of live rows per deduction may never exceed that deduction''s amount.';
COMMENT ON COLUMN expense_category."requiresPayee" IS 'Whether a disbursement in this category must name who was paid. UNLIKE requiresReceipt this one is ENFORCED: a missing receipt is a judgement call for the approver, a missing payee is a cost nobody can reconcile. Copied onto each row it governs — see liquidation_line.payeeRequired.';
COMMENT ON COLUMN expense_category."sortOrder" IS 'Lower appears first on expense forms. Defaults to 10 and the seeded categories are spaced 10 apart, so an unordered category lands beside the first rather than ahead of everything, and there is room to slot one between two others without renumbering.';
COMMENT ON COLUMN liquidation."custodianId" IS 'The staff member answerable for accounting for this cash. Nullable because the trip''s first liquidation is created at booking, before anybody is assigned. NOT the same as an allowance''s recipient: a helper can be handed ferry money the driver remains answerable for. Not necessarily on the truck either — a dispatch manager holds a trip''s float without driving or helping.';
COMMENT ON COLUMN liquidation.status IS 'Code set LiquidationStatus (@eztruckr/types): 1 PENDING, 2 SUBMITTED, 3 APPROVED. Order comes from the declared sequence, not from the number. Renumbered once in Phase 5, with stored rows remapped; append-only from here.';
COMMENT ON COLUMN liquidation."totalAllowance" IS 'Sum of THIS liquidation''s allowances — the releases booked against this custodian, not every release on the trip.';
COMMENT ON COLUMN liquidation_history.action IS 'Code set LiquidationHistoryAction (@eztruckr/types): 1 SUBMITTED, 2 RETURNED. Both leave the liquidation at a status it has held before, which is why this table exists at all.';
COMMENT ON COLUMN liquidation_history."actorId" IS 'Who submitted or returned. Separate from createdBy because the actor is the point of the row — the crew portal renders it — not an audit footnote.';
COMMENT ON COLUMN liquidation_line."payeeId" IS 'Who the crew paid. Required exactly when payeeRequired is true, enforced by liquidation_line_payee_required.';
COMMENT ON COLUMN liquidation_line."payeeRequired" IS 'Whether THIS line had to name a payee, copied from its expense category when the line was written. Frozen, never read live: enforcing against the category''s current value would retroactively invalidate rows recorded under the old rule and block correcting them.';
COMMENT ON COLUMN payee."payeeType" IS 'Code set PayeeType (@eztruckr/types): 1 COMPANY, 2 INDIVIDUAL. Stated, never inferred — no rule over the name tells a sole proprietor from a partnership, and the two produce different vouchers. Deliberately has no STAFF code: cash to a crew member is an allowance pointing at staff, not a disbursement to a payee.';
COMMENT ON COLUMN payee.tin IS 'Philippine taxpayer identification number, as printed on a voucher. Same purpose as client.tin.';
COMMENT ON COLUMN payout_run.status IS 'Code set PayoutRunStatus (@eztruckr/types): 1 DRAFT, 2 APPROVED, 3 PAID, 4 VOIDED. PAID is terminal, enforced by trigger.';
COMMENT ON COLUMN route."standardAllowance" IS 'What the crew are normally advanced for this run. A default that prefills the first allowance and is editable there; nothing downstream reads it, and variance is never measured against it.';
COMMENT ON COLUMN settlement.amount IS 'The variance, frozen from the liquidation at approval. Signed: positive = crew returns cash, negative = company reimburses crew. Never a P&L line.';
COMMENT ON COLUMN settlement."crewDeductionId" IS 'The ordinary CrewDeduction that carries this balance into payout. Set only at CARRIED_TO_PAYOUT; the settlement clears when that debt is fully recovered by runs marked Paid.';
COMMENT ON COLUMN settlement."disbursementMode" IS 'Code set DisbursementMode (@eztruckr/types): 1 CASH, 2 BANK_TRANSFER, 3 EWALLET. Null until the money moves, and null forever on a zero variance.';
COMMENT ON COLUMN settlement."liquidationId" IS 'Whose leftover cash this is. One live settlement per liquidation, not per shipment: two custodians each holding change cannot share a row, and the blended figure the old shape produced would chase one of them for the other''s money.';
COMMENT ON COLUMN settlement.status IS 'Code set SettlementStatus (@eztruckr/types): 1 OUTSTANDING, 2 SETTLED, 3 CARRIED_TO_PAYOUT. Read DIRECTLY by the allowances-outstanding alert; never inferred from the liquidation.';
COMMENT ON COLUMN shipment."appliedGasDeductionRate" IS 'OUTPUT. The rate the last computation actually used — the override if there was one, otherwise the system default as it stood then. Null until commissions are computed. Written only by the engine, never by a request.';
COMMENT ON COLUMN shipment."gasRateOverride" IS 'INPUT. The gas deduction rate somebody deliberately asked this shipment to use instead of the system default. Null means use the default. Always accompanied by gasRateOverrideReason, enforced by CHECK.';
COMMENT ON COLUMN shipment."gasRateOverrideReason" IS 'Why the override was applied. Mandatory whenever gasRateOverride is set: this rate moves the commission base for every crew member on the trip, so an unexplained override is indistinguishable from a typo at review time.';
COMMENT ON COLUMN shipment.status IS 'Code set ShipmentStatus (@eztruckr/types): 1 DRAFT, 2 DISPATCHED, 3 IN_TRANSIT, 4 DELIVERED, 5 PENDING_LIQUIDATION, 6 LIQUIDATED, 7 CLOSED. Workflow order comes from the declared sequence in @eztruckr/types, never from the numeric value. DELIVERED is written through to PENDING_LIQUIDATION in the same statement, so a delivered trip is never left looking un-acted-on.';
COMMENT ON COLUMN staff."eligibleRoles" IS 'Code set StaffRole (@eztruckr/types): 1 DRIVER, 2 HELPER, 3 DISPATCH_MANAGER. Roles this person MAY fill; the role actually filled on a trip is recorded on commission.role, which permits only the crew subset (1, 2).';
COMMENT ON COLUMN staff."staffCode" IS 'The person''s code on paper. Partial-unique WHERE "deletedAt" IS NULL.';
COMMENT ON COLUMN system_setting."gasExpenseDeductionRate" IS 'Share of fuel spend deducted before commission is computed. System-wide: not a per-role rate, and has no CommissionRule equivalent.';
COMMENT ON COLUMN "user".role IS 'Code set UserRole (@eztruckr/types): 1 ADMINISTRATOR, 2 OPERATIONS, 3 ACCOUNTING, 4 MANAGEMENT, 5 CREW, 6 DISPATCH_MANAGER. Not ranked — membership, never comparison.';
COMMENT ON COLUMN "user"."staffId" IS 'Which staff member this login belongs to. Required for CREW and DISPATCH_MANAGER and forbidden for every other role. A crew login is SCOPED by it; a dispatch manager is not, and carries it so their own floats can be told apart from everyone else''s.';
