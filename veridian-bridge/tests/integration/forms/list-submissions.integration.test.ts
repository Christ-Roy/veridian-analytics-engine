/**
 * ════════════════════════════════════════════════════════════════════════════
 * list-submissions.integration.test.ts — T3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `GET /api/admin/tenant/:workspaceId/forms` (Bearer admin) liste les
 * FormSubmission d'un tenant — pagination par curseur sur `createdAt desc`,
 * filtres `formSlug` / `since` / `until` / `limit`.
 *
 * Testé contre un VRAI Postgres : la pagination curseur s'appuie sur l'ordre
 * SQL réel (`ORDER BY createdAt DESC` + `cursor` + `skip:1`). Un fake ne
 * garantit pas que le curseur Prisma se comporte comme Postgres.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  seedSite,
  TEST_ADMIN_KEY,
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

const adminHeaders = { Authorization: `Bearer ${TEST_ADMIN_KEY}` };

interface ListResponse {
  workspaceId: string;
  items: Array<{
    id: string;
    formSlug: string;
    leadEmail: string | null;
    pageUrl: string | null;
  }>;
  nextCursor: string | null;
}

/** Crée N FormSubmission espacées dans le temps via h.prisma direct. */
async function seedSubmissions(
  siteId: string,
  specs: Array<{ formSlug: string; minutesAgo: number; email?: string }>,
): Promise<void> {
  for (const spec of specs) {
    let leadId: string | null = null;
    if (spec.email) {
      const lead = await h.prisma.lead.upsert({
        where: { siteId_email: { siteId, email: spec.email } },
        update: {},
        create: { siteId, email: spec.email, submissionsCount: 1 },
      });
      leadId = lead.id;
    }
    await h.prisma.formSubmission.create({
      data: {
        siteId,
        formSlug: spec.formSlug,
        data: { stub: true },
        leadId,
        pageUrl: `https://client.fr/${spec.formSlug}`,
        createdAt: new Date(Date.now() - spec.minutesAgo * 60_000),
      },
    });
  }
}

// ─── 1. Listing de base + tri par date décroissante ─────────────────────────

test("list: GET forms renvoie les submissions triées par createdAt desc", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_list" });
  const site = await seedSite(h.prisma, tenant.id);

  await seedSubmissions(site.id, [
    { formSlug: "contact", minutesAgo: 30, email: "old@example.com" },
    { formSlug: "contact", minutesAgo: 10, email: "mid@example.com" },
    { formSlug: "newsletter", minutesAgo: 1, email: "new@example.com" },
  ]);

  const res = await fetch(
    `${h.url}/api/admin/tenant/ws_list/forms`,
    { headers: adminHeaders },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as ListResponse;
  assert.equal(body.workspaceId, "ws_list");
  assert.equal(body.items.length, 3);
  // La plus récente d'abord.
  assert.equal(body.items[0].leadEmail, "new@example.com");
  assert.equal(body.items[2].leadEmail, "old@example.com");
  assert.equal(body.nextCursor, null, "tout tient sur une page");
});

// ─── 2. Filtre formSlug ─────────────────────────────────────────────────────

test("list: filtre formSlug ne renvoie que les submissions du form ciblé", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_filter" });
  const site = await seedSite(h.prisma, tenant.id);

  await seedSubmissions(site.id, [
    { formSlug: "contact", minutesAgo: 5 },
    { formSlug: "contact", minutesAgo: 4 },
    { formSlug: "newsletter", minutesAgo: 3 },
  ]);

  const res = await fetch(
    `${h.url}/api/admin/tenant/ws_filter/forms?formSlug=contact`,
    { headers: adminHeaders },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as ListResponse;
  assert.equal(body.items.length, 2);
  assert.ok(
    body.items.every((i) => i.formSlug === "contact"),
    "seules les submissions 'contact' doivent ressortir",
  );
});

// ─── 3. Pagination curseur réelle ───────────────────────────────────────────

test("list: pagination par curseur — limit + nextCursor cohérents sur Postgres", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_page" });
  const site = await seedSite(h.prisma, tenant.id);

  // 5 submissions, espacées d'1 min.
  await seedSubmissions(
    site.id,
    Array.from({ length: 5 }, (_, i) => ({
      formSlug: "contact",
      minutesAgo: i + 1,
    })),
  );

  // Page 1 : limit=2.
  const page1Res = await fetch(
    `${h.url}/api/admin/tenant/ws_page/forms?limit=2`,
    { headers: adminHeaders },
  );
  const page1 = (await page1Res.json()) as ListResponse;
  assert.equal(page1.items.length, 2, "page 1 doit avoir 2 items");
  assert.ok(page1.nextCursor, "page 1 doit annoncer une page suivante");

  // Page 2 : limit=2 + cursor.
  const page2Res = await fetch(
    `${h.url}/api/admin/tenant/ws_page/forms?limit=2&cursor=${page1.nextCursor}`,
    { headers: adminHeaders },
  );
  const page2 = (await page2Res.json()) as ListResponse;
  assert.equal(page2.items.length, 2, "page 2 doit avoir 2 items");

  // Page 3 : le dernier item, pas de curseur suivant.
  const page3Res = await fetch(
    `${h.url}/api/admin/tenant/ws_page/forms?limit=2&cursor=${page2.nextCursor}`,
    { headers: adminHeaders },
  );
  const page3 = (await page3Res.json()) as ListResponse;
  assert.equal(page3.items.length, 1, "page 3 = dernier item");
  assert.equal(page3.nextCursor, null, "plus de page après");

  // Aucun doublon entre les pages — le curseur Postgres ne chevauche pas.
  const allIds = [
    ...page1.items.map((i) => i.id),
    ...page2.items.map((i) => i.id),
    ...page3.items.map((i) => i.id),
  ];
  assert.equal(
    new Set(allIds).size,
    5,
    "les 3 pages couvrent les 5 submissions sans doublon",
  );
});

// ─── 4. Filtre temporel since/until ─────────────────────────────────────────

test("list: filtres since/until restreignent la fenêtre temporelle", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_time" });
  const site = await seedSite(h.prisma, tenant.id);

  await seedSubmissions(site.id, [
    { formSlug: "contact", minutesAgo: 120 }, // 2h
    { formSlug: "contact", minutesAgo: 30 },
    { formSlug: "contact", minutesAgo: 5 },
  ]);

  // since = il y a 60 min → exclut la submission de 2h.
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const res = await fetch(
    `${h.url}/api/admin/tenant/ws_time/forms?since=${encodeURIComponent(since)}`,
    { headers: adminHeaders },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as ListResponse;
  assert.equal(
    body.items.length,
    2,
    "seules les 2 submissions récentes (< 60 min) doivent ressortir",
  );
});

// ─── 5. Tenant inexistant → 404 ─────────────────────────────────────────────

test("list: workspaceId inexistant → 404 tenant_not_found", async () => {
  const res = await fetch(
    `${h.url}/api/admin/tenant/ws_ghost/forms`,
    { headers: adminHeaders },
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "tenant_not_found");
});

// ─── 6. Sans Bearer → 401 ───────────────────────────────────────────────────

test("list: sans Bearer admin → 401, pas d'accès aux données", async () => {
  const tenant = await seedTenant(h.prisma, { workspaceId: "ws_auth" });
  await seedSite(h.prisma, tenant.id);

  const res = await fetch(`${h.url}/api/admin/tenant/ws_auth/forms`);
  assert.equal(res.status, 401, "endpoint admin protégé par Bearer");
});
