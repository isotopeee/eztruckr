-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "role" SMALLINT NOT NULL DEFAULT 5,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "crewMemberId" TEXT,
    "lastLoginAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT,
    "phone" TEXT,
    "avatarKey" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en-PH',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Manila',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(6),
    "refreshTokenExpiresAt" TIMESTAMPTZ(6),
    "scope" TEXT,
    "idToken" TEXT,
    "password" TEXT,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck" (
    "id" TEXT NOT NULL,
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
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_member" (
    "id" TEXT NOT NULL,
    "employeeCode" TEXT NOT NULL,
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
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "crew_member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
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
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "third_party" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "defaultCommissionRate" DECIMAL(5,4),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "third_party_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "route" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "distanceKm" DECIMAL(10,2),
    "standardRate" DECIMAL(15,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_category" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "requiresReceipt" BOOLEAN NOT NULL DEFAULT true,
    "defaultCommissionable" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "expense_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_rule" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" SMALLINT NOT NULL,
    "method" SMALLINT NOT NULL DEFAULT 1,
    "rate" DECIMAL(5,4),
    "fixedAmount" DECIMAL(15,4),
    "clientId" TEXT,
    "routeId" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMPTZ(6) NOT NULL,
    "effectiveTo" TIMESTAMPTZ(6),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "commission_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "gasExpenseDeductionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.25,
    "driverCommissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.15,
    "helperCommissionRate" DECIMAL(5,4) NOT NULL DEFAULT 0.075,
    "currencyCode" TEXT NOT NULL DEFAULT 'PHP',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Manila',
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" TEXT NOT NULL,
    "shipmentNumber" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "clientId" TEXT NOT NULL,
    "thirdPartyId" TEXT,
    "routeId" TEXT,
    "truckId" TEXT,
    "origin" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "cargoDescription" TEXT,
    "driverId" TEXT,
    "helperId" TEXT,
    "dispatchedAt" TIMESTAMPTZ(6),
    "deliveredAt" TIMESTAMPTZ(6),
    "closedAt" TIMESTAMPTZ(6),
    "grossRate" DECIMAL(15,4) NOT NULL,
    "tpcAmount" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "netRate" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "appliedTpcRate" DECIMAL(5,4),
    "appliedGasDeductionRate" DECIMAL(5,4),
    "gasRateOverrideReason" TEXT,
    "commissionableCharges" DECIMAL(15,4),
    "grossForCommission" DECIMAL(15,4),
    "gasDeductionAmount" DECIMAL(15,4),
    "commissionableBase" DECIMAL(15,4),
    "commissionsComputedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allowance" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "issuedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "allowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidation" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "totalAllowance" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalLiquidated" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "variance" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMPTZ(6),
    "approvedBy" TEXT,
    "finalizedAt" TIMESTAMPTZ(6),
    "finalizedBy" TEXT,
    "remarks" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "liquidation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "liquidation_line" (
    "id" TEXT NOT NULL,
    "liquidationId" TEXT NOT NULL,
    "expenseCategoryId" TEXT NOT NULL,
    "description" TEXT,
    "amount" DECIMAL(15,4) NOT NULL,
    "spentAt" TIMESTAMPTZ(6) NOT NULL,
    "receiptId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "liquidation_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "checksum" TEXT,
    "uploadedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billable_expense" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "expenseCategoryId" TEXT,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "isCommissionable" BOOLEAN NOT NULL DEFAULT false,
    "receiptId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "billable_expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "additional_charge" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "isCommissionable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "additional_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crew_deduction" (
    "id" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "shipmentId" TEXT,
    "reason" TEXT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "recovered" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "isSettled" BOOLEAN NOT NULL DEFAULT false,
    "incurredAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutLineId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "crew_deduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "adjustment" (
    "id" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "direction" SMALLINT NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutLineId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "role" SMALLINT NOT NULL,
    "appliedMethod" SMALLINT NOT NULL DEFAULT 1,
    "commissionableBase" DECIMAL(15,4) NOT NULL,
    "appliedRate" DECIMAL(5,4) NOT NULL,
    "amount" DECIMAL(15,4) NOT NULL,
    "computedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payoutLineId" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "commission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_run" (
    "id" TEXT NOT NULL,
    "runNumber" TEXT NOT NULL,
    "status" SMALLINT NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMPTZ(6) NOT NULL,
    "periodEnd" TIMESTAMPTZ(6) NOT NULL,
    "totalGross" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalDeductions" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalAdjustments" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "totalNet" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "approvedAt" TIMESTAMPTZ(6),
    "approvedBy" TEXT,
    "paidAt" TIMESTAMPTZ(6),
    "paidBy" TEXT,
    "voidedAt" TIMESTAMPTZ(6),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "payout_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payout_line" (
    "id" TEXT NOT NULL,
    "payoutRunId" TEXT NOT NULL,
    "crewMemberId" TEXT NOT NULL,
    "grossAmount" DECIMAL(15,4) NOT NULL,
    "deductionAmount" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "adjustmentAmount" DECIMAL(15,4) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(15,4) NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

    CONSTRAINT "payout_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
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
    "createdBy" TEXT NOT NULL,
    "updatedBy" TEXT,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedBy" TEXT,

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
CREATE INDEX "crew_member_isActive_idx" ON "crew_member"("isActive");

-- CreateIndex
CREATE INDEX "crew_member_lastName_firstName_idx" ON "crew_member"("lastName", "firstName");

-- CreateIndex
CREATE INDEX "crew_member_deletedAt_idx" ON "crew_member"("deletedAt");

-- CreateIndex
CREATE INDEX "client_isActive_idx" ON "client"("isActive");

-- CreateIndex
CREATE INDEX "client_deletedAt_idx" ON "client"("deletedAt");

-- CreateIndex
CREATE INDEX "third_party_isActive_idx" ON "third_party"("isActive");

-- CreateIndex
CREATE INDEX "third_party_deletedAt_idx" ON "third_party"("deletedAt");

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
CREATE INDEX "allowance_crewMemberId_idx" ON "allowance"("crewMemberId");

-- CreateIndex
CREATE INDEX "allowance_deletedAt_idx" ON "allowance"("deletedAt");

-- CreateIndex
CREATE INDEX "liquidation_shipmentId_idx" ON "liquidation"("shipmentId");

-- CreateIndex
CREATE INDEX "liquidation_status_idx" ON "liquidation"("status");

-- CreateIndex
CREATE INDEX "liquidation_deletedAt_idx" ON "liquidation"("deletedAt");

-- CreateIndex
CREATE INDEX "liquidation_line_liquidationId_idx" ON "liquidation_line"("liquidationId");

-- CreateIndex
CREATE INDEX "liquidation_line_expenseCategoryId_idx" ON "liquidation_line"("expenseCategoryId");

-- CreateIndex
CREATE INDEX "liquidation_line_deletedAt_idx" ON "liquidation_line"("deletedAt");

-- CreateIndex
CREATE INDEX "receipt_deletedAt_idx" ON "receipt"("deletedAt");

-- CreateIndex
CREATE INDEX "billable_expense_shipmentId_idx" ON "billable_expense"("shipmentId");

-- CreateIndex
CREATE INDEX "billable_expense_deletedAt_idx" ON "billable_expense"("deletedAt");

-- CreateIndex
CREATE INDEX "additional_charge_shipmentId_idx" ON "additional_charge"("shipmentId");

-- CreateIndex
CREATE INDEX "additional_charge_deletedAt_idx" ON "additional_charge"("deletedAt");

-- CreateIndex
CREATE INDEX "crew_deduction_crewMemberId_isSettled_idx" ON "crew_deduction"("crewMemberId", "isSettled");

-- CreateIndex
CREATE INDEX "crew_deduction_payoutLineId_idx" ON "crew_deduction"("payoutLineId");

-- CreateIndex
CREATE INDEX "crew_deduction_deletedAt_idx" ON "crew_deduction"("deletedAt");

-- CreateIndex
CREATE INDEX "adjustment_crewMemberId_idx" ON "adjustment"("crewMemberId");

-- CreateIndex
CREATE INDEX "adjustment_payoutLineId_idx" ON "adjustment"("payoutLineId");

-- CreateIndex
CREATE INDEX "adjustment_deletedAt_idx" ON "adjustment"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "commission_payoutLineId_key" ON "commission"("payoutLineId");

-- CreateIndex
CREATE INDEX "commission_shipmentId_idx" ON "commission"("shipmentId");

-- CreateIndex
CREATE INDEX "commission_crewMemberId_idx" ON "commission"("crewMemberId");

-- CreateIndex
CREATE INDEX "commission_deletedAt_idx" ON "commission"("deletedAt");

-- CreateIndex
CREATE INDEX "payout_run_status_idx" ON "payout_run"("status");

-- CreateIndex
CREATE INDEX "payout_run_deletedAt_idx" ON "payout_run"("deletedAt");

-- CreateIndex
CREATE INDEX "payout_line_payoutRunId_idx" ON "payout_line"("payoutRunId");

-- CreateIndex
CREATE INDEX "payout_line_crewMemberId_idx" ON "payout_line"("crewMemberId");

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
ALTER TABLE "user" ADD CONSTRAINT "user_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_member" ADD CONSTRAINT "crew_member_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_helperId_fkey" FOREIGN KEY ("helperId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment" ADD CONSTRAINT "shipment_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allowance" ADD CONSTRAINT "allowance_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_finalizedBy_fkey" FOREIGN KEY ("finalizedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation" ADD CONSTRAINT "liquidation_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_liquidationId_fkey" FOREIGN KEY ("liquidationId") REFERENCES "liquidation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "liquidation_line" ADD CONSTRAINT "liquidation_line_expenseCategoryId_fkey" FOREIGN KEY ("expenseCategoryId") REFERENCES "expense_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "additional_charge" ADD CONSTRAINT "additional_charge_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_payoutLineId_fkey" FOREIGN KEY ("payoutLineId") REFERENCES "payout_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_updatedBy_fkey" FOREIGN KEY ("updatedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crew_deduction" ADD CONSTRAINT "crew_deduction_deletedBy_fkey" FOREIGN KEY ("deletedBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "adjustment" ADD CONSTRAINT "adjustment_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "commission" ADD CONSTRAINT "commission_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "payout_line" ADD CONSTRAINT "payout_line_crewMemberId_fkey" FOREIGN KEY ("crewMemberId") REFERENCES "crew_member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
