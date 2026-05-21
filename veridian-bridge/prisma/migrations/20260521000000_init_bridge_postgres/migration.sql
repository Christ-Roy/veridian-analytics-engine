-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hubTenantId" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "planSource" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "apiKey" TEXT,
    "suspendedAt" TIMESTAMP(3),
    "softDeletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscProperty" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "siteUrl" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "ownershipState" TEXT NOT NULL DEFAULT 'pending',
    "lastSyncAt" TIMESTAMP(3),
    "oauthAccount" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GscProperty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GscDaily" (
    "id" TEXT NOT NULL,
    "gscPropertyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "query" TEXT NOT NULL DEFAULT '',
    "page" TEXT NOT NULL DEFAULT '',
    "country" TEXT NOT NULL DEFAULT '',
    "device" TEXT NOT NULL DEFAULT '',
    "searchType" TEXT NOT NULL DEFAULT 'web',
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "position" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ctr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GscDaily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_workspaceId_key" ON "Tenant"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_hubTenantId_key" ON "Tenant"("hubTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_apiKey_key" ON "Tenant"("apiKey");

-- CreateIndex
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

-- CreateIndex
CREATE INDEX "Tenant_hubTenantId_idx" ON "Tenant"("hubTenantId");

-- CreateIndex
CREATE INDEX "GscProperty_ownershipState_idx" ON "GscProperty"("ownershipState");

-- CreateIndex
CREATE UNIQUE INDEX "GscProperty_tenantId_siteUrl_key" ON "GscProperty"("tenantId", "siteUrl");

-- CreateIndex
CREATE INDEX "GscDaily_gscPropertyId_date_idx" ON "GscDaily"("gscPropertyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "GscDaily_gscPropertyId_date_query_page_country_device_searc_key" ON "GscDaily"("gscPropertyId", "date", "query", "page", "country", "device", "searchType");

-- AddForeignKey
ALTER TABLE "GscProperty" ADD CONSTRAINT "GscProperty_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GscDaily" ADD CONSTRAINT "GscDaily_gscPropertyId_fkey" FOREIGN KEY ("gscPropertyId") REFERENCES "GscProperty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

