/**
 * ════════════════════════════════════════════════════════════════════════════
 * settings-credentials.integration.test.ts — U8 contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Couvre `src/settings/*` + `src/credentials/*` + les routes HTTP, contre un
 * vrai Postgres (harness `bootBridgeWithRealDB`).
 *
 * Ce que ça PROUVE (impossible avec FakePrisma) :
 *
 *   - La migration `20260522000100_add_tenant_credentials_settings` s'applique
 *     pour de vrai (`prisma migrate deploy` au boot) — les tables
 *     `TenantCredential` / `TenantSettings` existent réellement.
 *   - Chiffrement AES-256-GCM round-trip via une vraie colonne JSONB : on
 *     écrit un credential, on relit la colonne `encryptedData` directement en
 *     SQL et on vérifie qu'AUCUN secret n'apparaît en clair. Le clear-text
 *     n'existe que si on déchiffre avec la clé.
 *   - Contrainte `@@unique([tenantId, kind])` : un `POST /credentials` répété
 *     sur le même (tenant, kind) fait un upsert (1 seule row), pas un doublon.
 *   - Cascade FK : supprimer un Tenant emporte ses TenantCredential et
 *     TenantSettings (ON DELETE CASCADE réel).
 *   - Le contrat `TenantSettings` upsert : première écriture crée la row.
 *
 * ─── Isolation ──────────────────────────────────────────────────────────────
 *
 * Auto-isolant : chaque test seede son propre Tenant (workspaceId unique via
 * randomUUID) et n'assert QUE sur des entités scopées. Pas de `resetDb()`.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  seedTenant,
  TEST_ADMIN_KEY,
  TEST_ENCRYPTION_KEY,
  type BridgeHarness,
} from "../_harness/index.js";
import { decryptJson, type EncryptedBlob } from "../../../src/credentials/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Seed un Tenant frais. Tous les champs uniques (`workspaceId`, `slug`,
 * `hubTenantId`, `apiKey`) reçoivent une valeur cross-process unique via
 * `randomUUID` — le runner d'intégration partage UNE base entre les fichiers,
 * donc le `seedCounter` per-process du harness ne suffit pas.
 */
async function mkTenant(): Promise<{ id: string; workspaceId: string }> {
  const suffix = randomUUID().slice(0, 12);
  const t = await seedTenant(h.prisma, {
    workspaceId: `ws_u8_${suffix}`,
    slug: `u8-${suffix}`,
    name: `U8 Tenant ${suffix}`,
    hubTenantId: `hub_u8_${suffix}`,
    apiKey: `sk_u8_${suffix}`,
  });
  return { id: t.id, workspaceId: t.workspaceId };
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    "Content-Type": "application/json",
  };
}

// ─── Migration appliquée : tables existent ──────────────────────────────────

test("la migration U8 a créé les tables TenantCredential / TenantSettings", async () => {
  // Si la migration n'avait pas tourné, ces requêtes throw.
  const credCount = await h.prisma.tenantCredential.count();
  const setCount = await h.prisma.tenantSettings.count();
  assert.ok(credCount >= 0);
  assert.ok(setCount >= 0);
});

// ─── Credentials : chiffrement réel + contrainte unique ─────────────────────

test("POST /credentials écrit un blob chiffré dans une colonne JSONB réelle", async () => {
  const tenant = await mkTenant();
  const res = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEYintegrationsecret12345" },
      }),
    },
  );
  assert.equal(res.status, 201);
  const raw = await res.text();
  // La réponse HTTP ne fuit jamais le secret.
  assert.ok(!raw.includes("KEYintegrationsecret12345"));

  // On relit la colonne directement en DB — c'est du chiffré.
  const row = await h.prisma.tenantCredential.findUnique({
    where: {
      tenantId_kind: { tenantId: tenant.id, kind: "voip_telnyx" },
    },
  });
  assert.ok(row);
  const blob = row.encryptedData as unknown as EncryptedBlob;
  assert.equal(blob.v, 1);
  // Le secret n'apparaît pas dans le ciphertext.
  assert.ok(!JSON.stringify(blob).includes("KEYintegrationsecret12345"));
  // Mais il se déchiffre correctement avec la clé.
  const clear = decryptJson<{ apiKey: string }>(blob, TEST_ENCRYPTION_KEY);
  assert.equal(clear.apiKey, "KEYintegrationsecret12345");
});

test("POST /credentials répété = upsert (@@unique tenantId+kind, pas de doublon)", async () => {
  const tenant = await mkTenant();
  for (const apiKey of [
    "KEYfirstvalueintegration1",
    "KEYsecondvalueintegration",
  ]) {
    const res = await fetch(
      `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials`,
      {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ kind: "voip_telnyx", creds: { apiKey } }),
      },
    );
    assert.equal(res.status, 201);
  }
  const count = await h.prisma.tenantCredential.count({
    where: { tenantId: tenant.id, kind: "voip_telnyx" },
  });
  assert.equal(count, 1);
  // La dernière valeur a gagné.
  const row = await h.prisma.tenantCredential.findUnique({
    where: { tenantId_kind: { tenantId: tenant.id, kind: "voip_telnyx" } },
  });
  const clear = decryptJson<{ apiKey: string }>(
    row!.encryptedData as unknown as EncryptedBlob,
    TEST_ENCRYPTION_KEY,
  );
  assert.equal(clear.apiKey, "KEYsecondvalueintegration");
});

test("deux kinds différents = deux rows pour le même tenant", async () => {
  const tenant = await mkTenant();
  await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEYtelnyxintegration12345" },
      }),
    },
  );
  await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_ovh",
        creds: {
          applicationKey: "ovh-app-key-integration",
          applicationSecret: "ovh-app-secret-integration",
          consumerKey: "ovh-consumer-key-integration",
        },
      }),
    },
  );
  const count = await h.prisma.tenantCredential.count({
    where: { tenantId: tenant.id },
  });
  assert.equal(count, 2);
});

test("DELETE /credentials/:kind supprime la row réelle", async () => {
  const tenant = await mkTenant();
  await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEYdeleteintegration12345" },
      }),
    },
  );
  const res = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials/voip_telnyx`,
    { method: "DELETE", headers: authHeaders() },
  );
  assert.equal(res.status, 200);
  const count = await h.prisma.tenantCredential.count({
    where: { tenantId: tenant.id, kind: "voip_telnyx" },
  });
  assert.equal(count, 0);
});

// ─── Cascade FK ─────────────────────────────────────────────────────────────

test("supprimer un Tenant cascade sur TenantCredential et TenantSettings", async () => {
  const tenant = await mkTenant();
  // Crée un credential + des settings.
  await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/credentials`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEYcascadeintegration1234" },
      }),
    },
  );
  await fetch(`${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ notifyNewLead: false }),
  });
  assert.equal(
    await h.prisma.tenantCredential.count({ where: { tenantId: tenant.id } }),
    1,
  );
  assert.equal(
    await h.prisma.tenantSettings.count({ where: { tenantId: tenant.id } }),
    1,
  );

  // Suppression du tenant → cascade.
  await h.prisma.tenant.delete({ where: { id: tenant.id } });
  assert.equal(
    await h.prisma.tenantCredential.count({ where: { tenantId: tenant.id } }),
    0,
  );
  assert.equal(
    await h.prisma.tenantSettings.count({ where: { tenantId: tenant.id } }),
    0,
  );
});

// ─── Settings : GET / PUT contre Postgres ───────────────────────────────────

test("GET /settings agrège la config tenant — vue complète", async () => {
  const tenant = await mkTenant();
  await h.prisma.site.create({
    data: {
      tenantId: tenant.id,
      siteKey: `sk_${randomUUID().slice(0, 8)}`,
      domain: "integration-acme.fr",
      name: "Site Integration",
    },
  });
  const res = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`,
    { headers: authHeaders() },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    tenant: { workspaceId: string };
    sites: Array<{ domain: string }>;
    gsc: { connected: boolean };
    credentials: unknown[];
    notifications: { notifyNewLead: boolean };
  };
  assert.equal(body.tenant.workspaceId, tenant.workspaceId);
  assert.equal(body.sites.length, 1);
  assert.equal(body.sites[0].domain, "integration-acme.fr");
  assert.equal(body.gsc.connected, false);
  assert.equal(body.notifications.notifyNewLead, true);
});

test("PUT /settings crée la row TenantSettings au premier write (upsert réel)", async () => {
  const tenant = await mkTenant();
  // Aucune row au départ.
  assert.equal(
    await h.prisma.tenantSettings.count({ where: { tenantId: tenant.id } }),
    0,
  );
  const res = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({
        notifyWeeklyReport: false,
        cookieConsentEnabled: true,
        notifyEmail: "integration@acme.fr",
      }),
    },
  );
  assert.equal(res.status, 200);
  const row = await h.prisma.tenantSettings.findUnique({
    where: { tenantId: tenant.id },
  });
  assert.ok(row);
  assert.equal(row.notifyWeeklyReport, false);
  assert.equal(row.cookieConsentEnabled, true);
  assert.equal(row.notifyEmail, "integration@acme.fr");
  // Défaut conservé sur les champs non touchés.
  assert.equal(row.notifyNewLead, true);
});

test("PUT /settings deux fois = patch incrémental, toujours 1 row", async () => {
  const tenant = await mkTenant();
  await fetch(`${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ notifyNewLead: false }),
  });
  await fetch(`${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`, {
    method: "PUT",
    headers: authHeaders(),
    body: JSON.stringify({ visitorIdEnabled: false }),
  });
  const count = await h.prisma.tenantSettings.count({
    where: { tenantId: tenant.id },
  });
  assert.equal(count, 1);
  const row = await h.prisma.tenantSettings.findUnique({
    where: { tenantId: tenant.id },
  });
  assert.equal(row!.notifyNewLead, false);
  assert.equal(row!.visitorIdEnabled, false);
});

test("GET /settings tenant inconnu → 404", async () => {
  const res = await fetch(
    `${h.url}/api/admin/tenant/ws_does_not_exist_u8/settings`,
    { headers: authHeaders() },
  );
  assert.equal(res.status, 404);
});

test("auth Bearer obligatoire sur les routes settings", async () => {
  const tenant = await mkTenant();
  const noAuth = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`,
  );
  assert.equal(noAuth.status, 401);
  const badAuth = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/settings`,
    { headers: { Authorization: "Bearer nope" } },
  );
  assert.equal(badAuth.status, 403);
});
