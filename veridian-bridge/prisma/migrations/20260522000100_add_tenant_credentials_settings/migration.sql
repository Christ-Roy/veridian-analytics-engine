-- U8 — TenantCredential + TenantSettings
--
-- Migration ADDITIVE : ajoute deux tables, ne touche AUCUNE table existante.
--   - TenantCredential : credentials VoIP self-service chiffrés AES-256-GCM
--   - TenantSettings   : préférences notifications + tracking (1:1 Tenant)
-- Les relations inverses sur Tenant (`credentials`, `settings`) sont
-- virtuelles côté Prisma — pas de DDL sur la table Tenant.

-- CreateTable
CREATE TABLE "TenantCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedData" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'untested',
    "lastSyncAt" TIMESTAMP(3),
    "lastTestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantSettings" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "notifyNewLead" BOOLEAN NOT NULL DEFAULT true,
    "notifyWeeklyReport" BOOLEAN NOT NULL DEFAULT true,
    "notifyEmail" TEXT,
    "pushAdminEnabled" BOOLEAN NOT NULL DEFAULT true,
    "visitorIdEnabled" BOOLEAN NOT NULL DEFAULT true,
    "cookieConsentEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantCredential_tenantId_kind_key" ON "TenantCredential"("tenantId", "kind");

-- CreateIndex
CREATE INDEX "TenantCredential_tenantId_idx" ON "TenantCredential"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantSettings_tenantId_key" ON "TenantSettings"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantCredential" ADD CONSTRAINT "TenantCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TenantSettings" ADD CONSTRAINT "TenantSettings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
