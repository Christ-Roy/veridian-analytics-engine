-- B-VOIP — VoIP call logs (SipCall)
--
-- Migration additive : ajoute la table SipCall. Aucune modification du modèle
-- Tenant existant (la relation inverse `Tenant.sipCalls` est virtuelle côté
-- Prisma, pas de DDL).
--
-- Les credentials VoIP vivent dans `TenantCredential` (kind voip_ovh /
-- voip_telnyx, table créée par la migration U8 20260522000100). B-VOIP ne
-- crée PAS de table de creds — il consomme TenantCredential. Timestamp
-- ordonné après U8 (20260522000100) pour que la FK implicite soit safe.

-- CreateTable
CREATE TABLE "SipCall" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteId" TEXT,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "durationSec" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "recordingUrl" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "visitorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SipCall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SipCall_provider_externalId_key" ON "SipCall"("provider", "externalId");

-- CreateIndex
CREATE INDEX "SipCall_tenantId_startedAt_idx" ON "SipCall"("tenantId", "startedAt");

-- AddForeignKey
ALTER TABLE "SipCall" ADD CONSTRAINT "SipCall_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
