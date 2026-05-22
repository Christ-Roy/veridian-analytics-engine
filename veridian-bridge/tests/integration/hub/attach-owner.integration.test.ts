/**
 * ════════════════════════════════════════════════════════════════════════════
 * attach-owner.integration.test.ts — POST /api/tenants/attach-owner, vrai Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T2. Couvre `src/hub/attach-owner.ts` + `PrismaTenantStore.attachOwner`.
 *
 * Ce que ça prouve, qu'un FakePrisma ne prouverait pas :
 *   - attach-owner écrit RÉELLEMENT le lien user↔tenant dans la table annexe
 *     `TenantOwner` de Postgres (relu en SQL direct).
 *   - Un re-attach du même (tenant, email, user_id) est idempotent :
 *     `already_attached:true` ET la table `TenantOwner` ne contient qu'UNE
 *     seule row pour ce tenant (l'ON CONFLICT DO UPDATE ne crée pas de doublon).
 *   - Un tenant inexistant → 404, et aucune row TenantOwner créée.
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

/** Lit la (les) row(s) TenantOwner pour un tenantId donné. */
async function ownerRows(tenantId: string) {
  return h.prisma.$queryRawUnsafe<
    { tenantId: string; ownerEmail: string | null; ownerUserId: string | null }[]
  >(`SELECT * FROM "TenantOwner" WHERE "tenantId" = $1`, tenantId);
}

// ─── attach-owner réussi → lien réel en DB ──────────────────────────────────

test("attach-owner sur tenant existant → 200 et lien user↔tenant RÉEL en Postgres", async () => {
  const tenant = await seedTenant(h.prisma, { hubTenantId: "hub_attach_1" });

  const res = await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_attach_1",
    owner_email: "owner@attach.example",
    user_id: "usr_real_42",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    attached: boolean;
    already_attached: boolean;
    user_id: string;
    role: string;
  };
  assert.equal(body.attached, true);
  assert.equal(body.already_attached, false, "premier attach → pas déjà attaché");
  assert.equal(body.user_id, "usr_real_42");
  assert.equal(body.role, "owner", "role par défaut = owner");

  // LA preuve : la row TenantOwner existe vraiment en Postgres.
  const rows = await ownerRows(tenant.id);
  assert.equal(rows.length, 1, "exactement une row TenantOwner");
  assert.equal(rows[0].ownerEmail, "owner@attach.example");
  assert.equal(rows[0].ownerUserId, "usr_real_42");
});

test("attach-owner sans user_id → user_id dérivé de l'email, persisté", async () => {
  const tenant = await seedTenant(h.prisma, { hubTenantId: "hub_attach_noid" });
  const res = await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_attach_noid",
    owner_email: "derive@x.example",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user_id: string };
  assert.ok(body.user_id.startsWith("usr_"), "user_id dérivé du pattern usr_*");

  const rows = await ownerRows(tenant.id);
  assert.equal(rows[0].ownerUserId, body.user_id, "user_id dérivé persisté en DB");
});

test("attach-owner avec role:admin → role respecté dans la réponse", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_attach_admin" });
  const res = await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_attach_admin",
    owner_email: "adm@x.example",
    user_id: "usr_adm",
    role: "admin",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { role: string };
  assert.equal(body.role, "admin");
});

// ─── re-attach idempotent → pas de doublon en DB ────────────────────────────

test("re-attach identique → already_attached:true et UNE SEULE row TenantOwner", async () => {
  const tenant = await seedTenant(h.prisma, { hubTenantId: "hub_attach_idem" });

  const payload = {
    tenant_id: "hub_attach_idem",
    owner_email: "stable@x.example",
    user_id: "usr_stable",
  };

  // 1er attach.
  const first = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/attach-owner",
    payload,
  );
  assert.equal(first.status, 200);
  assert.equal(
    ((await first.json()) as { already_attached: boolean }).already_attached,
    false,
  );

  // 2e attach IDENTIQUE.
  const second = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/attach-owner",
    payload,
  );
  assert.equal(second.status, 200);
  assert.equal(
    ((await second.json()) as { already_attached: boolean }).already_attached,
    true,
    "re-attach identique → already_attached:true",
  );

  // L'ON CONFLICT DO UPDATE ne crée PAS de doublon : toujours 1 row.
  const rows = await ownerRows(tenant.id);
  assert.equal(
    rows.length,
    1,
    "re-attach ne doit jamais créer une 2e row TenantOwner",
  );
  assert.equal(rows[0].ownerUserId, "usr_stable");

  // Vérif globale : 1 seule row dans toute la table.
  const total = await h.prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*)::int AS c FROM "TenantOwner"`,
  );
  assert.equal(Number(total[0].c), 1);
});

test("re-attach avec un user_id DIFFÉRENT → mute la row (pas un doublon)", async () => {
  const tenant = await seedTenant(h.prisma, { hubTenantId: "hub_attach_mut" });

  await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_attach_mut",
    owner_email: "same@x.example",
    user_id: "usr_old",
  });
  const reattach = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/attach-owner",
    {
      tenant_id: "hub_attach_mut",
      owner_email: "same@x.example",
      user_id: "usr_new",
    },
  );
  assert.equal(reattach.status, 200);
  assert.equal(
    ((await reattach.json()) as { already_attached: boolean }).already_attached,
    false,
    "user_id différent → pas 'already_attached'",
  );

  const rows = await ownerRows(tenant.id);
  assert.equal(rows.length, 1, "toujours UNE row — UPDATE, pas INSERT");
  assert.equal(rows[0].ownerUserId, "usr_new", "la row a été mise à jour");
});

// ─── tenant inexistant → 404 ────────────────────────────────────────────────

test("attach-owner sur tenant inexistant → 404 et aucune row TenantOwner", async () => {
  const res = await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_ghost_tenant",
    owner_email: "ghost@x.example",
    user_id: "usr_ghost",
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "tenant_not_found");

  const total = await h.prisma.$queryRawUnsafe<{ c: bigint }[]>(
    `SELECT COUNT(*)::int AS c FROM "TenantOwner"`,
  );
  assert.equal(
    Number(total[0].c),
    0,
    "aucun lien owner ne doit être créé pour un tenant fantôme",
  );
});

// ─── validation du body ─────────────────────────────────────────────────────

test("attach-owner body invalide (email manquant) → 400 validation_failed", async () => {
  await seedTenant(h.prisma, { hubTenantId: "hub_attach_badbody" });
  const res = await signedFetch(h.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "hub_attach_badbody",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "validation_failed");
});
