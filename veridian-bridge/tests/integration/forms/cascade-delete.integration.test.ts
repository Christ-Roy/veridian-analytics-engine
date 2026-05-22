/**
 * ════════════════════════════════════════════════════════════════════════════
 * cascade-delete.integration.test.ts — T3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le schéma déclare des FK `onDelete: Cascade` :
 *   - FormSubmission.site   → onDelete: Cascade
 *   - FormSchema.site       → onDelete: Cascade
 *   - Lead.site             → onDelete: Cascade
 *   - LeadSession.lead      → onDelete: Cascade
 *   - Site.tenant           → onDelete: Cascade
 *
 * Conséquence : supprimer un Site doit emporter ses FormSubmission / FormSchema
 * / Lead, et la suppression du Lead doit elle-même emporter ses LeadSession.
 * Idem en supprimant un Tenant : la cascade traverse Tenant → Site → tout.
 *
 * Ce comportement est PUREMENT Postgres (la FK SQL). Impossible à vérifier sur
 * un FakePrismaClient — c'est exactement le genre de bug que ce ticket cible.
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

/** Ingère une soumission complète (lead + session) via l'API. */
async function ingest(siteKey: string, email: string): Promise<void> {
  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey,
      formSlug: "contact",
      data: { email },
      visitorId: `v-${email}`,
      sessionId: `s-${email}`,
    }),
  });
  assert.equal(res.status, 200);
}

// ─── 1. Supprimer un Site → cascade sur FormSubmission/FormSchema/Lead ──────

test("cascade: supprimer un Site emporte ses FormSubmission/FormSchema/Lead/LeadSession", async () => {
  const tenant = await seedTenant(h.prisma);
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_cascade" });

  await ingest("pk_cascade", "lead1@example.com");
  await ingest("pk_cascade", "lead2@example.com");

  // État avant suppression.
  assert.equal(await h.prisma.formSubmission.count(), 2);
  assert.equal(await h.prisma.formSchema.count(), 1);
  assert.equal(await h.prisma.lead.count(), 2);
  assert.equal(await h.prisma.leadSession.count(), 2);

  // DELETE du Site → la cascade FK Postgres doit tout emporter.
  await h.prisma.site.delete({ where: { id: site.id } });

  assert.equal(
    await h.prisma.formSubmission.count(),
    0,
    "les FormSubmission doivent cascader",
  );
  assert.equal(
    await h.prisma.formSchema.count(),
    0,
    "les FormSchema doivent cascader",
  );
  assert.equal(await h.prisma.lead.count(), 0, "les Lead doivent cascader");
  assert.equal(
    await h.prisma.leadSession.count(),
    0,
    "les LeadSession doivent cascader (via le Lead)",
  );
  // Le tenant lui-même n'est PAS touché.
  assert.equal(await h.prisma.tenant.count(), 1, "le Tenant survit");
});

// ─── 2. Supprimer un Lead → cascade sur ses LeadSession seulement ───────────

test("cascade: supprimer un Lead emporte ses LeadSession mais garde la FormSubmission", async () => {
  const tenant = await seedTenant(h.prisma);
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_lead_cascade" });

  await ingest("pk_lead_cascade", "deleteme@example.com");

  const lead = await h.prisma.lead.findFirstOrThrow({
    where: { siteId: site.id },
  });
  assert.equal(await h.prisma.leadSession.count(), 1);
  assert.equal(await h.prisma.formSubmission.count(), 1);

  // DELETE du Lead.
  await h.prisma.lead.delete({ where: { id: lead.id } });

  assert.equal(
    await h.prisma.leadSession.count(),
    0,
    "LeadSession.lead onDelete: Cascade → la session disparaît",
  );
  // FormSubmission.lead n'a PAS de onDelete: Cascade (relation optionnelle) :
  // la submission survit, son leadId devient orphelin/null selon la FK.
  assert.equal(
    await h.prisma.formSubmission.count(),
    1,
    "la FormSubmission n'a pas de cascade depuis Lead — elle survit",
  );
});

// ─── 3. Supprimer un Tenant → cascade complète Tenant → Site → tout ─────────

test("cascade: supprimer un Tenant traverse toute la hiérarchie", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_tenant_a" });
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_tenant_b" });

  await ingest("pk_tenant_a", "a@example.com");
  await ingest("pk_tenant_b", "b@example.com");

  assert.equal(await h.prisma.site.count(), 2);
  assert.equal(await h.prisma.formSubmission.count(), 2);
  assert.equal(await h.prisma.lead.count(), 2);
  assert.equal(await h.prisma.leadSession.count(), 2);

  // DELETE du Tenant → cascade jusqu'aux feuilles.
  await h.prisma.tenant.delete({ where: { id: tenant.id } });

  assert.equal(await h.prisma.site.count(), 0, "Sites cascadés");
  assert.equal(await h.prisma.formSubmission.count(), 0, "FormSubmission cascadés");
  assert.equal(await h.prisma.formSchema.count(), 0, "FormSchema cascadés");
  assert.equal(await h.prisma.lead.count(), 0, "Lead cascadés");
  assert.equal(await h.prisma.leadSession.count(), 0, "LeadSession cascadés");
  assert.equal(await h.prisma.tenant.count(), 0);
});
