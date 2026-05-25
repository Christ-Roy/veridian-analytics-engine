-- TenantPhoneNumber — phone source dimension (2026-05-25)
--
-- Migration additive : ajoute la table `TenantPhoneNumber` + l'enum
-- `PhoneNumberSource`. Permet le mapping `e164 → source de trafic` consommé
-- par le push event `phone_call` vers staminads (cf src/voip/sync.ts).
--
-- Pas d'impact sur les rows `SipCall` existantes ni sur le modèle Tenant
-- (la relation inverse `Tenant.phoneNumbers` est virtuelle côté Prisma — pas
-- de DDL). Pas de backfill : un tenant n'ayant aucun numéro tracké tombera
-- sur `source = 'direct'` (default safe côté sync).
--
-- Timestamp ordonné après la dernière migration (20260523000000_drop_forms_leads)
-- pour respecter l'ordre temporel.

-- CreateEnum
CREATE TYPE "PhoneNumberSource" AS ENUM ('seo', 'ads', 'direct', 'email', 'social', 'print', 'other');

-- CreateTable
CREATE TABLE "TenantPhoneNumber" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "source" "PhoneNumberSource" NOT NULL DEFAULT 'direct',
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantPhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TenantPhoneNumber_tenantId_e164_key" ON "TenantPhoneNumber"("tenantId", "e164");

-- CreateIndex
CREATE INDEX "TenantPhoneNumber_tenantId_idx" ON "TenantPhoneNumber"("tenantId");

-- AddForeignKey
ALTER TABLE "TenantPhoneNumber" ADD CONSTRAINT "TenantPhoneNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
