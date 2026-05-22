/**
 * ════════════════════════════════════════════════════════════════════════════
 * missing-sitekey.integration.test.ts — T3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Un POST avec un siteKey inexistant (ou un tenant soft-deleted) doit :
 *   - renvoyer 401 invalid_site_key
 *   - n'écrire RIEN en Postgres (pas de FormSubmission, pas de Lead orphelin)
 *
 * Vérifié contre un vrai Postgres : on compte les rows AVANT et APRÈS pour
 * prouver qu'aucune écriture parasite n'a eu lieu.
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

// ─── 1. siteKey inexistant → 401, rien en DB ────────────────────────────────

test("missing: siteKey inconnu → 401 invalid_site_key, aucune row créée", async () => {
  // On seed un site VALIDE pour prouver qu'on ne tape simplement pas le bon.
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_real" });

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "pk_does_not_exist",
      formSlug: "contact",
      data: { email: "ghost@example.com" },
    }),
  });

  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_site_key");

  // ── Aucune écriture parasite en Postgres ──
  assert.equal(await h.prisma.formSubmission.count(), 0, "0 FormSubmission");
  assert.equal(await h.prisma.lead.count(), 0, "0 Lead");
  assert.equal(await h.prisma.formSchema.count(), 0, "0 FormSchema");
  assert.equal(await h.prisma.leadSession.count(), 0, "0 LeadSession");
});

// ─── 2. tenant soft-deleted → siteKey valide mais refusé ────────────────────

test("missing: site d'un tenant soft-deleted → 401, rien en DB", async () => {
  // Le siteKey EXISTE bien, mais le tenant a été soft-deleted.
  const tenant = await seedTenant(h.prisma, {
    workspaceId: "ws_deleted",
    softDeletedAt: new Date(),
  });
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_soft_deleted" });

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "pk_soft_deleted",
      formSlug: "contact",
      data: { email: "user@example.com" },
    }),
  });

  assert.equal(res.status, 401, "un tenant soft-deleted doit refuser l'ingest");
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_site_key");

  assert.equal(await h.prisma.formSubmission.count(), 0);
  assert.equal(await h.prisma.lead.count(), 0);
});

// ─── 3. siteKey valide d'un autre tenant ACTIF → ça marche (contrôle) ───────

test("missing: contrôle — un siteKey valide d'un tenant actif passe bien", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_ok" });
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_active" });

  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey: "pk_active",
      formSlug: "contact",
      data: { email: "ok@example.com" },
    }),
  });

  assert.equal(res.status, 200, "le contrôle positif doit réussir");
  assert.equal(await h.prisma.formSubmission.count(), 1);
});
