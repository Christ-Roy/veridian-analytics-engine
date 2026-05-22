/**
 * ════════════════════════════════════════════════════════════════════════════
 * health.integration.test.ts — GET /api/tenants/:id/health, vrai Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T2. Couvre `src/hub/health.ts` + lecture du `PrismaTenantStore`.
 *
 * Ce que ça prouve, qu'un FakePrisma ne prouverait pas :
 *   - /health relit l'état du tenant DEPUIS Postgres (status, plan, apiKey,
 *     owner attaché via la table annexe `TenantOwner`).
 *   - Avec un hook `loadStats` qui interroge RÉELLEMENT la table `Site`, le
 *     `sites_count` renvoyé reflète le nombre exact de rows Site en DB —
 *     pas un compteur en mémoire.
 *   - `owner_attached` / `magic_link_capable` sont calculés sur des données
 *     Postgres réelles (mutation de status via la DB).
 *
 * Le harness `loadStats` est branché ici sur un vrai query Prisma `site.count`
 * → si le schéma Site casse ou la FK saute, ce fichier devient rouge.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  seedSite,
  type BridgeHarness,
} from "../_harness/index.js";
import { signedFetch } from "../_harness/signed-fetch.js";

let h: BridgeHarness;

before(async () => {
  // loadStats RÉEL : compte les rows Site en Postgres pour le tenant.
  // C'est ce qui rend le test "intégration" : la métrique vient de la DB.
  h = await bootBridgeWithRealDB({
    loadStats: async (tenant) => {
      const sitesCount = await h.prisma.site.count({
        where: { tenantId: tenant.id },
      });
      return { lastEventAt: null, sitesCount, pageviews30d: 0 };
    },
  });
});

after(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDb(h.prisma);
});

interface HealthBody {
  tenant_id: string;
  workspace_id: string;
  status: string;
  owner_attached: boolean;
  owner_email: string | null;
  owner_user_id: string | null;
  api_key_valid: boolean;
  magic_link_capable: boolean;
  plan: string;
  last_event_at: string | null;
  sites_count: number;
  pageviews_30d: number;
  checked_at: string;
}

// ─── état lifecycle lu depuis Postgres ──────────────────────────────────────

test("health — tenant actif fraîchement seedé → payload lu depuis Postgres", async () => {
  await seedTenant(h.prisma, {
    hubTenantId: "hub_health_fresh",
    plan: "pro",
    apiKey: "sk_health_fresh",
  });

  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_fresh/health",
    undefined,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as HealthBody;
  assert.equal(body.tenant_id, "hub_health_fresh");
  assert.equal(body.status, "active");
  assert.equal(body.plan, "pro");
  assert.equal(body.api_key_valid, true, "apiKey présente en DB → valid");
  assert.equal(body.owner_attached, false, "pas d'owner attaché");
  assert.equal(body.magic_link_capable, false);
  assert.equal(body.sites_count, 0, "aucun Site seedé");
  assert.match(body.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

// ─── sites_count RÉELLEMENT calculé depuis la table Site ────────────────────

test("health — sites_count reflète le nombre EXACT de rows Site en Postgres", async () => {
  const tenant = await seedTenant(h.prisma, { hubTenantId: "hub_health_sites" });

  // 3 sites RÉELS rattachés à ce tenant.
  await seedSite(h.prisma, tenant.id);
  await seedSite(h.prisma, tenant.id);
  await seedSite(h.prisma, tenant.id);

  // Un site rattaché à un AUTRE tenant — ne doit PAS être compté.
  const other = await seedTenant(h.prisma, { hubTenantId: "hub_health_other" });
  await seedSite(h.prisma, other.id);

  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_sites/health",
    undefined,
  );
  const body = (await res.json()) as HealthBody;
  assert.equal(
    body.sites_count,
    3,
    "sites_count = COUNT(*) réel des Site du tenant, pas des autres",
  );
});

test("health — sites_count à 0 quand le tenant n'a aucun Site", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_health_nosite" });
  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_nosite/health",
    undefined,
  );
  const body = (await res.json()) as HealthBody;
  assert.equal(body.sites_count, 0);
});

// ─── owner_attached / magic_link_capable calculés sur données réelles ───────

test("health — après attach-owner → owner_attached et magic_link_capable true", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_health_attached" });

  // attach-owner REND la table TenantOwner non-vide pour ce tenant.
  await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_health_attached",
    owner_email: "owner@health.example",
    user_id: "usr_health",
  });

  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_attached/health",
    undefined,
  );
  const body = (await res.json()) as HealthBody;
  assert.equal(body.owner_attached, true, "owner lu depuis TenantOwner");
  assert.equal(body.owner_email, "owner@health.example");
  assert.equal(body.owner_user_id, "usr_health");
  assert.equal(
    body.magic_link_capable,
    true,
    "owner attaché + status active → magic-link capable",
  );
});

test("health — tenant suspended en DB → status=suspended, magic_link_capable=false", async () => {
  // Status non-actif directement en Postgres.
  await seedTenant(h.prisma, {
    hubTenantId: "hub_health_susp",
    status: "suspended",
  });
  await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_health_susp",
    owner_email: "owner@susp.example",
    user_id: "usr_susp",
  });

  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_susp/health",
    undefined,
  );
  const body = (await res.json()) as HealthBody;
  assert.equal(body.status, "suspended", "status lu depuis Postgres");
  assert.equal(body.owner_attached, true);
  assert.equal(
    body.magic_link_capable,
    false,
    "status != active → pas magic-link même avec owner",
  );
});

test("health — apiKey null en DB → api_key_valid:false", async () => {
  await seedTenant(h.prisma, {
    hubTenantId: "hub_health_nokey",
    apiKey: null,
  });
  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_nokey/health",
    undefined,
  );
  const body = (await res.json()) as HealthBody;
  assert.equal(body.api_key_valid, false);
});

// ─── tenant inexistant ──────────────────────────────────────────────────────

test("health — tenant inexistant → 404 tenant_not_found", async () => {
  const res = await signedFetch(
    h.url,
    "GET",
    "/api/tenants/hub_health_ghost/health",
    undefined,
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "tenant_not_found");
});

// ─── HMAC requis sur /health aussi ──────────────────────────────────────────

test("health — requête NON signée → 401 (la route est sous HMAC)", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_health_unsigned" });
  // fetch brut, sans headers HMAC.
  const res = await fetch(
    `${h.url}/api/tenants/hub_health_unsigned/health`,
  );
  assert.equal(res.status, 401);
});
