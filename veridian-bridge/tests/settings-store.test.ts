/**
 * Tests unitaires — couche DB settings tenant (U8).
 *
 * Couvre `src/settings/store.ts` :
 *   - getTenantSettings : agrège tenant + sites + GSC + creds + prefs
 *   - défauts quand aucune row TenantSettings
 *   - updateTenantSettings : upsert + patch partiel
 *   - GSC connected/propertyUrl résolus correctement
 *   - error path : tenant inconnu
 *   - les creds renvoyées dans la vue sont masquées
 *
 * Tourne sur `FakePrismaClientWithSettings` (in-memory).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import {
  getTenantSettings,
  updateTenantSettings,
  SettingsError,
} from "../src/settings/store.js";
import { saveCredential } from "../src/credentials/store.js";
import { FakePrismaClientWithSettings } from "./helpers/fake-prisma-settings.js";

const KEY = "d".repeat(64);
const asPrisma = (p: FakePrismaClientWithSettings) =>
  p as unknown as PrismaClient;

async function seed(): Promise<FakePrismaClientWithSettings> {
  const prisma = new FakePrismaClientWithSettings();
  await prisma.tenant.create({
    data: {
      id: "t1",
      workspaceId: "ws1",
      slug: "acme",
      name: "Acme Corp",
      plan: "pro",
      status: "active",
    },
  });
  await prisma.site.create({
    data: {
      tenantId: "t1",
      siteKey: "sk_abc123",
      domain: "acme.fr",
      name: "Site Acme",
    },
  });
  return prisma;
}

// ─── getTenantSettings ──────────────────────────────────────────────────────

test("getTenantSettings agrège l'identité tenant et les sites", async () => {
  const prisma = await seed();
  const view = await getTenantSettings(asPrisma(prisma), "ws1", KEY);
  assert.equal(view.tenant.name, "Acme Corp");
  assert.equal(view.tenant.slug, "acme");
  assert.equal(view.tenant.plan, "pro");
  assert.equal(view.sites.length, 1);
  assert.equal(view.sites[0].domain, "acme.fr");
  assert.equal(view.sites[0].siteKey, "sk_abc123");
});

test("getTenantSettings renvoie les défauts quand aucune row TenantSettings", async () => {
  const prisma = await seed();
  const view = await getTenantSettings(asPrisma(prisma), "ws1", KEY);
  assert.equal(view.notifications.notifyNewLead, true);
  assert.equal(view.notifications.notifyWeeklyReport, true);
  assert.equal(view.notifications.notifyEmail, null);
  assert.equal(view.notifications.pushAdminEnabled, true);
  assert.equal(view.tracking.visitorIdEnabled, true);
  assert.equal(view.tracking.cookieConsentEnabled, false);
});

test("getTenantSettings — GSC non connecté quand aucune property", async () => {
  const prisma = await seed();
  const view = await getTenantSettings(asPrisma(prisma), "ws1", KEY);
  assert.equal(view.gsc.connected, false);
  assert.equal(view.gsc.propertyUrl, null);
});

test("getTenantSettings — GSC connecté avec property réelle", async () => {
  const prisma = await seed();
  await prisma.gscProperty.create({
    data: {
      tenantId: "t1",
      siteUrl: "sc-domain:acme.fr",
      type: "DOMAIN",
      ownershipState: "verified",
      lastSyncAt: new Date("2026-05-20T10:00:00Z"),
    },
  });
  const view = await getTenantSettings(asPrisma(prisma), "ws1", KEY);
  assert.equal(view.gsc.connected, true);
  assert.equal(view.gsc.propertyUrl, "sc-domain:acme.fr");
  assert.equal(view.gsc.ownershipState, "verified");
  assert.equal(view.gsc.lastSyncAt, "2026-05-20T10:00:00.000Z");
});

test("getTenantSettings — GSC connecté mais property __pending__ (OAuth fait, pas de prop)", async () => {
  const prisma = await seed();
  await prisma.gscProperty.create({
    data: {
      tenantId: "t1",
      siteUrl: "__pending__",
      type: "SITE",
      ownershipState: "pending",
    },
  });
  const view = await getTenantSettings(asPrisma(prisma), "ws1", KEY);
  assert.equal(view.gsc.connected, true);
  assert.equal(view.gsc.propertyUrl, null);
});

test("getTenantSettings — les credentials de la vue sont masqués", async () => {
  const prisma = await seed();
  await saveCredential(
    asPrisma(prisma),
    "t1",
    "voip_telnyx",
    { apiKey: "KEYsecretsecret12345678" },
    KEY,
  );
  const view = await getTenantSettings(asPrisma(prisma), "ws1", KEY);
  assert.equal(view.credentials.length, 1);
  assert.equal(view.credentials[0].kind, "voip_telnyx");
  const serialized = JSON.stringify(view.credentials);
  assert.ok(!serialized.includes("KEYsecretsecret12345678"));
});

test("getTenantSettings rejette un tenant inconnu", async () => {
  const prisma = await seed();
  await assert.rejects(
    () => getTenantSettings(asPrisma(prisma), "ws_unknown", KEY),
    (err: unknown) =>
      err instanceof SettingsError && err.code === "tenant_not_found",
  );
});

// ─── updateTenantSettings ───────────────────────────────────────────────────

test("updateTenantSettings crée la row et applique le patch", async () => {
  const prisma = await seed();
  const view = await updateTenantSettings(
    asPrisma(prisma),
    "ws1",
    { notifyNewLead: false, cookieConsentEnabled: true },
    KEY,
  );
  assert.equal(view.notifications.notifyNewLead, false);
  assert.equal(view.tracking.cookieConsentEnabled, true);
  // Les champs non touchés gardent leur défaut.
  assert.equal(view.notifications.notifyWeeklyReport, true);
  assert.equal(prisma.tenantSettingsRows.length, 1);
});

test("updateTenantSettings — patch partiel ne touche pas les autres champs", async () => {
  const prisma = await seed();
  await updateTenantSettings(
    asPrisma(prisma),
    "ws1",
    { notifyNewLead: false, visitorIdEnabled: false },
    KEY,
  );
  const view = await updateTenantSettings(
    asPrisma(prisma),
    "ws1",
    { notifyEmail: "alerts@acme.fr" },
    KEY,
  );
  // Le premier patch est conservé.
  assert.equal(view.notifications.notifyNewLead, false);
  assert.equal(view.tracking.visitorIdEnabled, false);
  // Le nouveau champ est appliqué.
  assert.equal(view.notifications.notifyEmail, "alerts@acme.fr");
  // Toujours une seule row (upsert).
  assert.equal(prisma.tenantSettingsRows.length, 1);
});

test("updateTenantSettings rejette un tenant inconnu", async () => {
  const prisma = await seed();
  await assert.rejects(
    () =>
      updateTenantSettings(
        asPrisma(prisma),
        "ws_unknown",
        { notifyNewLead: false },
        KEY,
      ),
    (err: unknown) =>
      err instanceof SettingsError && err.code === "tenant_not_found",
  );
});

test("updateTenantSettings permet de remettre notifyEmail à null", async () => {
  const prisma = await seed();
  await updateTenantSettings(
    asPrisma(prisma),
    "ws1",
    { notifyEmail: "x@acme.fr" },
    KEY,
  );
  const view = await updateTenantSettings(
    asPrisma(prisma),
    "ws1",
    { notifyEmail: null },
    KEY,
  );
  assert.equal(view.notifications.notifyEmail, null);
});
