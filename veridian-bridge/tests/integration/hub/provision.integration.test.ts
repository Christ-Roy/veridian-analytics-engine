/**
 * ════════════════════════════════════════════════════════════════════════════
 * provision.integration.test.ts — POST /api/tenants/provision contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T2. Couvre `src/hub/provision.ts` + `src/hub/store.ts` (PrismaTenantStore).
 *
 * Ce que ce fichier prouve, qu'un test FakePrisma ne prouverait PAS :
 *   - Cas A : un POST /provision écrit RÉELLEMENT une row dans la table
 *     `Tenant` de Postgres (relue via `h.prisma.tenant.findUnique`).
 *   - Cas B : un re-provision du même tenant est idempotent et persiste le
 *     refresh d'apiKey EN DB (pas juste en mémoire).
 *   - Cas C : un owner_email différent → 409, et la row Postgres n'est PAS
 *     mutée.
 *   - La VRAIE contrainte `@@unique` sur `workspaceId` / `hubTenantId` : une
 *     insertion en doublon lève un vrai `P2002` Postgres — pas une exception
 *     simulée par un fake.
 *
 * Boot : `bootBridgeWithRealDB()` câble `PrismaTenantStore` (Postgres réel) et
 * un hook staminads déterministe (aucun réseau).
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  type BridgeHarness,
} from "../_harness/index.js";
import { signedFetch } from "../_harness/signed-fetch.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDb(h.prisma);
});

/** Body provision valide minimal. */
function provisionBody(over: Partial<Record<string, unknown>> = {}) {
  return {
    tenant_id: "hub_tnt_prov_1",
    owner_email: "owner@acme.example",
    workspace_name: "Acme Corp",
    plan: "pro",
    ...over,
  };
}

// ─── Cas A : nouveau tenant ─────────────────────────────────────────────────

test("Cas A — provision nouveau tenant → 200, row Tenant RÉELLEMENT en Postgres", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_A" }),
  );
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    tenant_id: string;
    workspace_id: string;
    api_key: string;
    created: boolean;
    plan: string;
    owner_email: string;
    dashboard_url: string;
  };
  assert.equal(body.tenant_id, "hub_tnt_A");
  assert.equal(body.created, true);
  assert.equal(body.plan, "pro");
  assert.equal(body.owner_email, "owner@acme.example");
  assert.ok(body.api_key.length > 0, "une api_key doit être retournée");
  assert.ok(body.workspace_id.length > 0, "un workspace_id doit être retourné");
  assert.match(body.dashboard_url, /analytics\.app\.veridian\.site/);

  // LA preuve : la row est en Postgres, relue par un query INDÉPENDANT.
  const row = await h.prisma.tenant.findUnique({
    where: { hubTenantId: "hub_tnt_A" },
  });
  assert.ok(row, "le Tenant doit exister en Postgres après provision");
  assert.equal(row.plan, "pro");
  assert.equal(row.status, "active");
  assert.equal(row.apiKey, body.api_key, "apiKey persistée = apiKey renvoyée");
  assert.equal(row.workspaceId, body.workspace_id);
  assert.equal(row.planSource, "hub", "planSource par défaut = hub");

  // Le compteur de rows reflète l'INSERT réel : exactement 1.
  assert.equal(await h.prisma.tenant.count(), 1);
});

test("Cas A — owner_email persisté dans la table annexe TenantOwner", async () => {
  await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_owner", owner_email: "boss@x.example" }),
  );
  const row = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_owner" },
  });
  const owner = await h.prisma.$queryRawUnsafe<
    { ownerEmail: string | null }[]
  >(`SELECT "ownerEmail" FROM "TenantOwner" WHERE "tenantId" = $1`, row.id);
  assert.equal(owner[0]?.ownerEmail, "boss@x.example");
});

test("Cas A — plan_source du metadata override le défaut 'hub'", async () => {
  await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({
      tenant_id: "hub_tnt_psrc",
      metadata: { plan_source: "trial" },
    }),
  );
  const row = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_psrc" },
  });
  assert.equal(row.planSource, "trial");
});

// ─── Cas B : re-provision idempotent ────────────────────────────────────────

test("Cas B — re-provision même tenant → idempotent, apiKey refresh, created:false", async () => {
  // 1er provision.
  const first = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_B" }),
  );
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as { api_key: string; created: boolean };
  assert.equal(firstBody.created, true);

  const rowAfterFirst = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_B" },
  });

  // 2e provision : MÊME tenant_id, MÊME owner_email → refresh.
  const second = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_B" }),
  );
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as {
    api_key: string;
    created: boolean;
  };
  assert.equal(secondBody.created, false, "re-provision → created:false");

  // Toujours UNE seule row : pas de doublon créé.
  assert.equal(
    await h.prisma.tenant.count(),
    1,
    "re-provision ne doit pas créer une 2e row",
  );

  // La row a le même id (pas recréée) mais une apiKey rafraîchie EN DB.
  const rowAfterSecond = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_B" },
  });
  assert.equal(
    rowAfterSecond.id,
    rowAfterFirst.id,
    "même row Tenant (id stable)",
  );
  assert.equal(
    rowAfterSecond.apiKey,
    secondBody.api_key,
    "apiKey en DB = apiKey renvoyée par le 2e appel",
  );
  assert.notEqual(
    rowAfterSecond.apiKey,
    rowAfterFirst.apiKey,
    "le hook staminads déterministe incrémente → nouvelle apiKey",
  );
});

// ─── Cas C : conflit owner_email ────────────────────────────────────────────

test("Cas C — re-provision avec owner_email différent → 409 conflict", async () => {
  await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_C", owner_email: "first@x.example" }),
  );
  const rowBefore = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_C" },
  });

  const conflict = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_C", owner_email: "intruder@x.example" }),
  );
  assert.equal(conflict.status, 409);
  const body = (await conflict.json()) as { error: string; error_code: string };
  assert.equal(body.error, "tenant_conflict_owner");
  assert.equal(body.error_code, "conflict");

  // La row Postgres n'a PAS été mutée par la tentative en conflit.
  const rowAfter = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_C" },
  });
  assert.equal(rowAfter.apiKey, rowBefore.apiKey, "apiKey inchangée");
  assert.equal(await h.prisma.tenant.count(), 1, "toujours 1 seule row");

  // L'owner en DB est resté le premier.
  const owner = await h.prisma.$queryRawUnsafe<
    { ownerEmail: string | null }[]
  >(`SELECT "ownerEmail" FROM "TenantOwner" WHERE "tenantId" = $1`, rowAfter.id);
  assert.equal(owner[0]?.ownerEmail, "first@x.example");
});

// ─── Validation du body ─────────────────────────────────────────────────────

test("provision — body invalide (email malformé) → 400 validation_failed", async () => {
  const res = await signedFetch(h.url, "POST", "/api/tenants/provision", {
    tenant_id: "hub_tnt_bad",
    owner_email: "not-an-email",
    workspace_name: "X",
    plan: "pro",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "validation_failed");
  assert.equal(await h.prisma.tenant.count(), 0, "aucune row écrite");
});

test("provision — plan non supporté → 400, rien en DB", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_badplan", plan: "platinum_unicorn" }),
  );
  assert.equal(res.status, 400);
  assert.equal(await h.prisma.tenant.count(), 0);
});

// ─── La VRAIE contrainte @@unique parle ─────────────────────────────────────

test("contrainte @@unique workspaceId — INSERT direct en doublon → vrai P2002", async () => {
  // Un provision crée un workspaceId. On tente d'insérer un 2e Tenant avec
  // le MÊME workspaceId via Prisma direct → Postgres doit refuser.
  await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody({ tenant_id: "hub_tnt_wsdup" }),
  );
  const provisioned = await h.prisma.tenant.findUniqueOrThrow({
    where: { hubTenantId: "hub_tnt_wsdup" },
  });

  await assert.rejects(
    () =>
      seedTenant(h.prisma, {
        workspaceId: provisioned.workspaceId, // collision volontaire
        hubTenantId: "hub_tnt_wsdup_other",
      }),
    (err: unknown) => {
      assert.equal(
        (err as { code?: string }).code,
        "P2002",
        "doit être une violation d'unicité workspaceId",
      );
      return true;
    },
  );
  assert.equal(await h.prisma.tenant.count(), 1, "la 2e insertion a échoué");
});

test("contrainte @@unique hubTenantId — INSERT direct en doublon → vrai P2002", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_dup_constraint" });
  await assert.rejects(
    () => seedTenant(h.prisma, { hubTenantId: "hub_dup_constraint" }),
    (err: unknown) => (err as { code?: string }).code === "P2002",
  );
  assert.equal(await h.prisma.tenant.count(), 1);
});

test("contrainte @@unique apiKey — deux tenants ne peuvent partager une apiKey", async () => {
  await seedTenant(h.prisma, { apiKey: "sk_shared_forbidden" });
  await assert.rejects(
    () => seedTenant(h.prisma, { apiKey: "sk_shared_forbidden" }),
    (err: unknown) => (err as { code?: string }).code === "P2002",
  );
});
