/**
 * ════════════════════════════════════════════════════════════════════════════
 * query.integration.test.ts — DSL dashboard GSC contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T4. Couvre `src/gsc/query.ts` (`queryProperty`, `dashboardSummary`,
 * `buildWhereFragments`).
 *
 * Ce que ça PROUVE (vs FakePrisma) :
 *
 *   `query.ts` n'utilise PAS l'ORM Prisma : il fait du `$queryRawUnsafe` avec
 *   du SQL agrégé (SUM, GROUP BY, ORDER BY, ILIKE, CASE WHEN). Le FakePrisma
 *   ré-implémente ce SQL en JavaScript — donc un test sur FakePrisma valide
 *   le FAKE, pas le vrai moteur Postgres. Ici on seede de vraies `GscDaily`
 *   et on vérifie que les agrégats (totals, topQueries, topPages, timeseries)
 *   sont calculés par de VRAIES requêtes SQL.
 *
 *   En particulier on couvre :
 *   - SUM/GROUP BY corrects (deux rows même query → cumul)
 *   - position pondérée par impressions (`SUM(position*impressions)/SUM(imp)`)
 *   - ctr recalculé `clicks/impressions`
 *   - ORDER BY clicks DESC + LIMIT/OFFSET (pagination)
 *   - filtres ILIKE (`contains`) et `equals`
 *   - dashboardSummary : résolution de la property verified la plus récente
 *     via une vraie jointure Tenant→GscProperty
 *
 * `dashboardSummary` calcule sa fenêtre via `Date.now()` (now-2j sur N jours).
 * Les fixtures sont donc seedées à des dates RELATIVES à aujourd'hui.
 *
 * ─── Isolation ──────────────────────────────────────────────────────────────
 *
 * Ce fichier est 100% AUTO-ISOLANT — il ne dépend d'aucun `resetDb()` ni d'un
 * ordre d'exécution. Chaque test seede son propre Tenant via `mkTenant` (id
 * unique cross-process) et n'assert QUE sur des entités scopées (`findUnique`,
 * `count({ where: { tenantId / gscPropertyId } })`). Conséquence : les tests
 * restent corrects même si les fichiers d'intégration se chevauchent sur le
 * Postgres partagé. Le runner `scripts/run-integration.mjs` (T3) exécute
 * en plus chaque fichier dans son propre process + sa propre base jetable,
 * mais la justesse de ce fichier n'en dépend pas.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  seedTenant,
  type BridgeHarness,
} from "../_harness/index.js";
import {
  queryProperty,
  dashboardSummary,
  type QueryRequest,
} from "../../../src/gsc/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

// Pas de `resetDb()` : ce fichier est 100% auto-isolant. Chaque test seede
// un Tenant à id unique (`mkTenant`) et n'assert QUE sur des entités scopées
// (`where` sur tenantId / gscPropertyId, `findUnique`). Aucune dépendance à
// l'état global → robuste même si les fichiers d'intégration se chevauchent.

/**
 * Seed un Tenant avec des identifiants uniques CROSS-PROCESS.
 *
 * `seedTenant` du harness génère des `workspaceId`/`slug` du type `ws_seed_N`
 * via un compteur RESET à chaque process. Or `node --test` lance un process
 * par fichier, tous sur le MÊME Postgres → deux fichiers génèrent `ws_seed_1`
 * et collisionnent (P2002). On force donc un préfixe unique par process
 * (`RUN_NONCE`) sur tous les champs `@unique`.
 */
const RUN_NONCE = randomUUID().slice(0, 8);
let localSeed = 0;
function mkTenant(slugHint = "t") {
  localSeed += 1;
  const tag = `${RUN_NONCE}-${localSeed}`;
  return seedTenant(h.prisma, {
    workspaceId: `ws_${tag}`,
    slug: `${slugHint}-${tag}`,
    hubTenantId: `hub_${tag}`,
    apiKey: `sk_${tag}`,
  });
}


/** Date UTC à minuit, `daysAgo` jours avant aujourd'hui. */
function dateDaysAgo(daysAgo: number): Date {
  const d = new Date(Date.now() - daysAgo * 86400000);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00Z`);
}

/** Insère une row GscDaily réelle (defaults raisonnables, overridables). */
async function seedDaily(
  gscPropertyId: string,
  row: {
    date: Date;
    query?: string;
    page?: string;
    country?: string;
    device?: string;
    searchType?: string;
    clicks: number;
    impressions: number;
    position: number;
  },
) {
  return h.prisma.gscDaily.create({
    data: {
      gscPropertyId,
      date: row.date,
      query: row.query ?? "kw",
      page: row.page ?? "/",
      country: row.country ?? "fra",
      device: row.device ?? "DESKTOP",
      searchType: row.searchType ?? "web",
      clicks: row.clicks,
      impressions: row.impressions,
      position: row.position,
      ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
    },
  });
}

/** Seed un Tenant + une GscProperty verified, retourne les deux. */
async function seedProperty(siteUrl = "https://example.com/") {
  const tenant = await mkTenant();
  const prop = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl,
      type: "SITE",
      ownershipState: "verified",
      lastSyncAt: new Date(),
    },
  });
  return { tenant, prop };
}

// ─── 1. queryProperty : totals agrégés par vraie requête SQL ────────────────

test("queryProperty: totals = SUM réel des clicks/impressions sur la fenêtre", async () => {
  const { prop } = await seedProperty();
  const d = dateDaysAgo(5);
  await seedDaily(prop.id, {
    date: d,
    query: "a",
    page: "/x",
    clicks: 10,
    impressions: 100,
    position: 4,
  });
  await seedDaily(prop.id, {
    date: d,
    query: "b",
    page: "/y",
    clicks: 30,
    impressions: 300,
    position: 8,
  });

  const req: QueryRequest = {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
  };
  const res = await queryProperty(h.prisma, req);

  // totals.clicks = 10+30, impressions = 100+300.
  assert.equal(res.totals.clicks, 40);
  assert.equal(res.totals.impressions, 400);
  // ctr = clicks / impressions = 40/400.
  assert.equal(res.totals.ctr, 0.1);
  // position pondérée : (4*100 + 8*300) / 400 = (400+2400)/400 = 7.
  assert.equal(res.totals.position, 7);

  // Sans dimensions → une seule row agrégée.
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].clicks, 40);
});

test("queryProperty: groupBy query → SUM par query, ORDER BY clicks DESC", async () => {
  const { prop } = await seedProperty();
  const d = dateDaysAgo(3);
  // "veridian" apparaît sur 2 rows (2 pages) → doit cumuler.
  await seedDaily(prop.id, {
    date: d,
    query: "veridian",
    page: "/a",
    clicks: 5,
    impressions: 50,
    position: 2,
  });
  await seedDaily(prop.id, {
    date: d,
    query: "veridian",
    page: "/b",
    clicks: 15,
    impressions: 150,
    position: 6,
  });
  await seedDaily(prop.id, {
    date: d,
    query: "analytics",
    page: "/a",
    clicks: 8,
    impressions: 80,
    position: 3,
  });

  const res = await queryProperty(h.prisma, {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
    dimensions: ["query"],
  });

  // 2 groupes distincts.
  assert.equal(res.rows.length, 2);
  assert.equal(res.totalRows, 2);
  // ORDER BY clicks DESC : "veridian" (5+15=20) avant "analytics" (8).
  assert.equal(res.rows[0].keys[0], "veridian");
  assert.equal(res.rows[0].clicks, 20);
  assert.equal(res.rows[0].impressions, 200);
  assert.equal(res.rows[1].keys[0], "analytics");
  assert.equal(res.rows[1].clicks, 8);
});

test("queryProperty: pagination LIMIT/OFFSET réelle", async () => {
  const { prop } = await seedProperty();
  const d = dateDaysAgo(3);
  // 5 queries, clics décroissants.
  for (let i = 0; i < 5; i++) {
    await seedDaily(prop.id, {
      date: d,
      query: `q${i}`,
      page: "/",
      clicks: 100 - i * 10,
      impressions: 1000,
      position: 1,
    });
  }
  const base: QueryRequest = {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
    dimensions: ["query"],
  };

  const page1 = await queryProperty(h.prisma, { ...base, rowLimit: 2, startRow: 0 });
  assert.equal(page1.rows.length, 2);
  assert.equal(page1.totalRows, 5, "totalRows ignore le LIMIT");
  assert.equal(page1.rows[0].keys[0], "q0"); // 100 clics

  const page2 = await queryProperty(h.prisma, { ...base, rowLimit: 2, startRow: 2 });
  assert.equal(page2.rows.length, 2);
  assert.equal(page2.rows[0].keys[0], "q2"); // 80 clics
});

test("queryProperty: filtre contains (ILIKE) appliqué en SQL", async () => {
  const { prop } = await seedProperty();
  const d = dateDaysAgo(3);
  await seedDaily(prop.id, {
    date: d,
    query: "veridian seo audit",
    page: "/a",
    clicks: 10,
    impressions: 100,
    position: 1,
  });
  await seedDaily(prop.id, {
    date: d,
    query: "google analytics",
    page: "/b",
    clicks: 20,
    impressions: 200,
    position: 1,
  });

  const res = await queryProperty(h.prisma, {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
    dimensions: ["query"],
    filters: [{ dimension: "query", operator: "contains", expression: "veridian" }],
  });
  // Seule la query contenant "veridian" remonte.
  assert.equal(res.rows.length, 1);
  assert.equal(res.rows[0].keys[0], "veridian seo audit");
  // totals reflètent aussi le filtre.
  assert.equal(res.totals.clicks, 10);
});

test("queryProperty: filtre equals sur device appliqué en SQL", async () => {
  const { prop } = await seedProperty();
  const d = dateDaysAgo(3);
  await seedDaily(prop.id, {
    date: d,
    query: "kw",
    page: "/a",
    device: "DESKTOP",
    clicks: 7,
    impressions: 70,
    position: 1,
  });
  await seedDaily(prop.id, {
    date: d,
    query: "kw",
    page: "/b",
    device: "MOBILE",
    clicks: 13,
    impressions: 130,
    position: 1,
  });

  const res = await queryProperty(h.prisma, {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
    filters: [{ dimension: "device", operator: "equals", expression: "MOBILE" }],
  });
  assert.equal(res.totals.clicks, 13, "seules les rows MOBILE comptent");
});

test("queryProperty: la fenêtre de dates exclut les rows hors bornes", async () => {
  const { prop } = await seedProperty();
  // Une row dans la fenêtre, une hors fenêtre (40j avant).
  await seedDaily(prop.id, {
    date: dateDaysAgo(5),
    query: "in",
    page: "/a",
    clicks: 100,
    impressions: 1000,
    position: 1,
  });
  await seedDaily(prop.id, {
    date: dateDaysAgo(40),
    query: "out",
    page: "/b",
    clicks: 999,
    impressions: 9999,
    position: 1,
  });

  const res = await queryProperty(h.prisma, {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
  });
  // Seule la row "in" est dans [now-10 ; now].
  assert.equal(res.totals.clicks, 100);
});

test("queryProperty: aucune data → totals à zéro, rows vide", async () => {
  const { prop } = await seedProperty();
  const res = await queryProperty(h.prisma, {
    gscPropertyId: prop.id,
    startDate: dateDaysAgo(10).toISOString().slice(0, 10),
    endDate: dateDaysAgo(0).toISOString().slice(0, 10),
    dimensions: ["query"],
  });
  assert.equal(res.totals.clicks, 0);
  assert.equal(res.totals.impressions, 0);
  assert.equal(res.rows.length, 0);
  assert.equal(res.totalRows, 0);
});

// ─── 2. dashboardSummary : totals + topQueries + topPages + timeseries ──────

test("dashboardSummary: agrège topQueries, topPages, timeseries sur la fenêtre", async () => {
  const { tenant, prop } = await seedProperty();

  // Seed 3 jours de data récents (dans la fenêtre 30j, après now-2j).
  // dashboardSummary : endDate = now-2j, startDate = endDate-(days-1).
  for (const ago of [5, 6, 7]) {
    await seedDaily(prop.id, {
      date: dateDaysAgo(ago),
      query: "veridian",
      page: "/pricing",
      clicks: 10,
      impressions: 100,
      position: 3,
    });
    await seedDaily(prop.id, {
      date: dateDaysAgo(ago),
      query: "analytics",
      page: "/features",
      clicks: 4,
      impressions: 80,
      position: 6,
    });
  }

  const summary = await dashboardSummary(h.prisma, {
    workspaceId: tenant.workspaceId,
    days: 30,
  });

  // La property verified du tenant est résolue via la jointure.
  assert.ok(summary.property);
  assert.equal(summary.property.id, prop.id);
  assert.equal(summary.property.siteUrl, "https://example.com/");

  // totals : 3 jours * (10+4) clics = 42 ; impressions 3*(100+80)=540.
  assert.equal(summary.totals.clicks, 42);
  assert.equal(summary.totals.impressions, 540);

  // topQueries : "veridian" (3*10=30) avant "analytics" (3*4=12).
  assert.equal(summary.topQueries.length, 2);
  assert.equal(summary.topQueries[0].keys[0], "veridian");
  assert.equal(summary.topQueries[0].clicks, 30);
  assert.equal(summary.topQueries[1].keys[0], "analytics");
  assert.equal(summary.topQueries[1].clicks, 12);

  // topPages : "/pricing" (30) avant "/features" (12).
  assert.equal(summary.topPages.length, 2);
  assert.equal(summary.topPages[0].keys[0], "/pricing");
  assert.equal(summary.topPages[0].clicks, 30);

  // timeseries : 3 jours distincts, triés par date ASC.
  assert.equal(summary.timeseries.length, 3);
  const dates = summary.timeseries.map((r) => r.keys[0]);
  const sorted = [...dates].sort();
  assert.deepEqual(dates, sorted, "timeseries triée par date croissante");
  // chaque jour : 10+4 = 14 clics.
  for (const r of summary.timeseries) {
    assert.equal(r.clicks, 14);
  }
});

test("dashboardSummary: workspace sans GscProperty → summary vide non-null", async () => {
  const tenant = await mkTenant("no-gsc");
  // Pas de GscProperty rattachée.
  const summary = await dashboardSummary(h.prisma, {
    workspaceId: tenant.workspaceId,
    days: 30,
  });
  assert.equal(summary.property, null);
  assert.equal(summary.totals.clicks, 0);
  assert.deepEqual(summary.topQueries, []);
  assert.deepEqual(summary.topPages, []);
  assert.deepEqual(summary.timeseries, []);
});

test("dashboardSummary: workspaceId inexistant → summary vide non-null", async () => {
  const summary = await dashboardSummary(h.prisma, {
    workspaceId: "ws_does_not_exist",
    days: 30,
  });
  assert.equal(summary.property, null);
  assert.equal(summary.totals.clicks, 0);
});

test("dashboardSummary: ignore les properties NON verified, prend la verified récente", async () => {
  const tenant = await mkTenant("multi-prop");

  // Une property pending (doit être ignorée).
  await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: "https://pending.example/",
      type: "SITE",
      ownershipState: "pending",
      lastSyncAt: new Date(),
    },
  });
  // Une property verified, syncée il y a longtemps.
  const old = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: "https://old.example/",
      type: "SITE",
      ownershipState: "verified",
      lastSyncAt: new Date(Date.now() - 30 * 86400000),
    },
  });
  // Une property verified, syncée récemment → c'est elle qui doit être choisie.
  const recent = await h.prisma.gscProperty.create({
    data: {
      tenantId: tenant.id,
      siteUrl: "https://recent.example/",
      type: "SITE",
      ownershipState: "verified",
      lastSyncAt: new Date(),
    },
  });

  await seedDaily(recent.id, {
    date: dateDaysAgo(5),
    query: "kw",
    page: "/",
    clicks: 50,
    impressions: 500,
    position: 1,
  });
  await seedDaily(old.id, {
    date: dateDaysAgo(5),
    query: "kw",
    page: "/",
    clicks: 999,
    impressions: 9999,
    position: 1,
  });

  const summary = await dashboardSummary(h.prisma, {
    workspaceId: tenant.workspaceId,
    days: 30,
  });
  // orderBy lastSyncAt desc, take 1 → la "recent".
  assert.equal(summary.property?.id, recent.id);
  assert.equal(summary.totals.clicks, 50, "data de la property récente");
});

test("dashboardSummary: gscPropertyId explicite court-circuite la résolution par workspace", async () => {
  const { prop } = await seedProperty();
  await seedDaily(prop.id, {
    date: dateDaysAgo(5),
    query: "kw",
    page: "/",
    clicks: 17,
    impressions: 170,
    position: 1,
  });
  const summary = await dashboardSummary(h.prisma, {
    workspaceId: "n_importe_quoi",
    days: 30,
    gscPropertyId: prop.id,
  });
  assert.equal(summary.property?.id, prop.id);
  assert.equal(summary.totals.clicks, 17);
});

// ─── 3. Bout-à-bout HTTP : GET /api/admin/tenant/:workspaceId/gsc ────────────

test("HTTP GET /api/admin/tenant/:workspaceId/gsc → dashboard summary depuis Postgres", async () => {
  const { tenant, prop } = await seedProperty();
  await seedDaily(prop.id, {
    date: dateDaysAgo(5),
    query: "veridian seo",
    page: "/pricing",
    clicks: 25,
    impressions: 300,
    position: 3.2,
  });

  const { TEST_ADMIN_KEY } = await import("../_harness/index.js");
  const res = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/gsc?days=30`,
    { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    workspaceId: string;
    property: { id: string } | null;
    totals: { clicks: number };
    topQueries: Array<{ keys: string[]; clicks: number }>;
  };
  assert.equal(body.workspaceId, tenant.workspaceId);
  assert.equal(body.property?.id, prop.id);
  assert.equal(body.totals.clicks, 25);
  assert.equal(body.topQueries[0].keys[0], "veridian seo");
});

test("HTTP GET /api/admin/tenant/:workspaceId/gsc → 401 sans Bearer", async () => {
  const { tenant } = await seedProperty();
  const res = await fetch(
    `${h.url}/api/admin/tenant/${tenant.workspaceId}/gsc`,
  );
  assert.equal(res.status, 401);
});
