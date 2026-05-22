/**
 * ════════════════════════════════════════════════════════════════════════════
 * dedup-by-email.integration.test.ts — T3 — LE test critique
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Le test unitaire `tests/forms/dedup-by-email.test.ts` valide la dedup…
 * contre un FakePrismaClient qui implémente LUI-MÊME la dedup. Ça ne prouve
 * RIEN — le fake pourrait avoir le même bug que le code.
 *
 * Ce fichier prouve la dedup contre la VRAIE contrainte Postgres
 * `@@unique([siteId, email])` (`Lead_siteId_email_key`) :
 *
 *   1. 2 POST même email + même site → 1 SEUL Lead, submissionsCount=2.
 *   2. La contrainte est COMPOSITE : même email sur 2 sites ≠ doublon.
 *   3. Une INSERT directe en doublon lève une vraie erreur P2002 (preuve
 *      que la contrainte SQL existe et mord).
 *
 * Si la migration oubliait `@@unique([siteId, email])`, le test #3 deviendrait
 * rouge — alors qu'il resterait vert sur le fake. C'est tout l'intérêt.
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

/** Helper : POST une soumission de form, renvoie le body JSON. */
async function postForm(
  siteKey: string,
  email: string,
  extra: Record<string, unknown> = {},
): Promise<{ ok: boolean; leadId: string; leadCreated: boolean }> {
  const res = await fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      siteKey,
      formSlug: "contact",
      data: { email, ...extra },
    }),
  });
  assert.equal(res.status, 200, `ingest devrait réussir (status ${res.status})`);
  return res.json() as Promise<{
    ok: boolean;
    leadId: string;
    leadCreated: boolean;
  }>;
}

// ─── 1. LE test : 2 POST même email/site → 1 seul Lead ──────────────────────

test("dedup: 2 POST même email + même site → 1 SEUL Lead, submissionsCount=2", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_dedup" });
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_dedup" });

  const first = await postForm("pk_dedup", "jean@example.com");
  assert.equal(first.leadCreated, true, "le 1er POST crée le lead");

  const second = await postForm("pk_dedup", "jean@example.com");
  assert.equal(second.leadCreated, false, "le 2e POST réutilise le lead");
  assert.equal(
    second.leadId,
    first.leadId,
    "même email/site → même leadId (dedup)",
  );

  // ── Preuve directe en Postgres : 1 seule row Lead ──
  const leads = await h.prisma.lead.findMany({ where: { siteId: site.id } });
  assert.equal(leads.length, 1, "il ne doit y avoir QU'UN lead en DB");
  assert.equal(leads[0].email, "jean@example.com");
  assert.equal(
    leads[0].submissionsCount,
    2,
    "submissionsCount incrémenté sur la 2e soumission",
  );

  // Les 2 FormSubmission existent et pointent sur le MÊME lead.
  const submissions = await h.prisma.formSubmission.findMany({
    where: { siteId: site.id },
  });
  assert.equal(submissions.length, 2, "2 soumissions distinctes en DB");
  assert.ok(
    submissions.every((s) => s.leadId === first.leadId),
    "les 2 submissions doivent pointer sur le même lead",
  );
});

// ─── 2. Dedup case-insensitive (email normalisé lowercase) ──────────────────

test("dedup: même email avec casse différente → toujours 1 seul Lead", async () => {
  const tenant = await seedTenant(h.prisma);
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_case" });

  await postForm("pk_case", "Marie.Dupont@Example.COM");
  await postForm("pk_case", "marie.dupont@example.com");
  await postForm("pk_case", "MARIE.DUPONT@EXAMPLE.COM");

  const leads = await h.prisma.lead.findMany({ where: { siteId: site.id } });
  assert.equal(leads.length, 1, "la casse ne doit pas créer de doublon");
  assert.equal(leads[0].email, "marie.dupont@example.com");
  assert.equal(leads[0].submissionsCount, 3);
});

// ─── 3. La contrainte est COMPOSITE : même email sur 2 sites ≠ doublon ──────

test("dedup: même email sur 2 sites DIFFÉRENTS → 2 Leads distincts", async () => {
  const tenant = await seedTenant(h.prisma);
  const siteA = await seedSite(h.prisma, tenant.id, { siteKey: "pk_siteA" });
  const siteB = await seedSite(h.prisma, tenant.id, { siteKey: "pk_siteB" });

  const onA = await postForm("pk_siteA", "shared@example.com");
  const onB = await postForm("pk_siteB", "shared@example.com");

  assert.equal(onA.leadCreated, true);
  assert.equal(onB.leadCreated, true, "le site B doit créer SON propre lead");
  assert.notEqual(
    onA.leadId,
    onB.leadId,
    "la contrainte est composite (siteId, email) — pas globale sur email",
  );

  const leadA = await h.prisma.lead.findUnique({
    where: { siteId_email: { siteId: siteA.id, email: "shared@example.com" } },
  });
  const leadB = await h.prisma.lead.findUnique({
    where: { siteId_email: { siteId: siteB.id, email: "shared@example.com" } },
  });
  assert.ok(leadA && leadB, "un lead par site doit exister");
  assert.notEqual(leadA.id, leadB.id);
  assert.equal(await h.prisma.lead.count(), 2, "2 leads au total");
});

// ─── 4. La VRAIE contrainte SQL mord : INSERT doublon → P2002 ───────────────

test("dedup: INSERT directe d'un Lead en doublon (siteId,email) → P2002 réel", async () => {
  const tenant = await seedTenant(h.prisma);
  const site = await seedSite(h.prisma, tenant.id);

  await h.prisma.lead.create({
    data: { siteId: site.id, email: "dup@example.com", submissionsCount: 1 },
  });

  // Bypass de la logique upsert de l'ingest : on attaque la contrainte SQL
  // en frontal. Si la migration avait oublié @@unique([siteId, email]),
  // cette ligne réussirait et le test deviendrait rouge.
  await assert.rejects(
    () =>
      h.prisma.lead.create({
        data: { siteId: site.id, email: "dup@example.com", submissionsCount: 1 },
      }),
    (err: unknown) => {
      const e = err as { code?: string };
      assert.equal(
        e.code,
        "P2002",
        "doit être une violation de la contrainte unique Postgres",
      );
      return true;
    },
    "un (siteId,email) en doublon DOIT lever P2002",
  );

  assert.equal(
    await h.prisma.lead.count(),
    1,
    "la 2e INSERT a échoué — toujours 1 lead",
  );
});

// ─── 5. Enrichissement progressif du lead via dedup ─────────────────────────

test("dedup: 2e soumission enrichit phone/name si absents la 1re fois", async () => {
  const tenant = await seedTenant(h.prisma);
  const site = await seedSite(h.prisma, tenant.id, { siteKey: "pk_enrich" });

  // 1er POST : email seul.
  await postForm("pk_enrich", "enrich@example.com");
  let lead = await h.prisma.lead.findFirstOrThrow({
    where: { siteId: site.id },
  });
  assert.equal(lead.phone, null);
  assert.equal(lead.name, null);

  // 2e POST : même email mais avec phone + name.
  await postForm("pk_enrich", "enrich@example.com", {
    phone: "0612345678",
    name: "Paul Enrichi",
  });
  lead = await h.prisma.lead.findFirstOrThrow({ where: { siteId: site.id } });
  assert.equal(lead.phone, "0612345678", "phone enrichi sur la 2e soumission");
  assert.equal(lead.name, "Paul Enrichi", "name enrichi sur la 2e soumission");
  assert.equal(lead.submissionsCount, 2);
  assert.equal(await h.prisma.lead.count(), 1, "toujours 1 seul lead");
});
