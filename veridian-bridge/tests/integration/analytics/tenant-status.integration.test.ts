/**
 * ════════════════════════════════════════════════════════════════════════════
 * tenant-status.integration.test.ts — GET /api/admin/tenant/:wsId/status
 *                                     contre une VRAIE staminads
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Couvre l'endpoint tenant-status (`src/app.ts`) + la lib
 * `src/tenant-status.ts` (`createTenantStatusBuilder`,
 * `makeStaminadsPageviewsFetcher`).
 *
 * Contrairement au test unitaire `tenant-status.test.ts` (qui injecte un
 * `pageviewsFetcher` mocké), ici on N'injecte RIEN : le bridge utilise son
 * vrai `makeStaminadsPageviewsFetcher`, qui fait un VRAI appel HTTP
 * `POST /api/analytics.query` vers la `RealStaminads`. Celle-ci compte les
 * pageviews en exécutant une RÉELLE agrégation ClickHouse sur des événements
 * vraiment insérés.
 *
 * Ce que ça prouve, qu'un fetcher mocké ne prouverait pas :
 *   - le chemin HTTP complet bridge → staminads → ClickHouse fonctionne ;
 *   - `makeStaminadsPageviewsFetcher` parse la réponse réelle correctement ;
 *   - un workspace avec des pageviews réels → `activeServices` inclut
 *     `pageviews` ; un workspace vide → tous les services inactifs.
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealStaminads,
  TEST_ADMIN_KEY,
  type StaminadsBridgeHarness,
} from "../_harness/index.js";
import { KNOWN_SERVICES, type SiteStatus } from "../../../src/tenant-status.js";
import { RealStaminads } from "./_real-staminads.js";

let staminads: RealStaminads;
let h: StaminadsBridgeHarness;

before(async () => {
  staminads = new RealStaminads();
  const staminadsUrl = await staminads.start();
  h = await bootBridgeWithRealStaminads({ staminadsUrl });
});

after(async () => {
  await h.close();
  await staminads.stop();
});

function uniqueWorkspaceId(label: string): string {
  return `ws_status_${label}_${randomUUID().replace(/-/g, "")}`;
}

function getStatus(workspaceId: string, withAuth = true) {
  return fetch(`${h.url}/api/admin/tenant/${workspaceId}/status`, {
    headers: withAuth ? { Authorization: `Bearer ${TEST_ADMIN_KEY}` } : {},
  });
}

// ─── 1. Workspace avec pageviews → activeServices inclut 'pageviews' ─────────

test("tenant-status: workspace avec pageviews → 'pageviews' actif (compté par CH réel)", async () => {
  const ws = uniqueWorkspaceId("live");
  // 1500 événements screen_view RÉELS en ClickHouse.
  await staminads.seedPageviews(ws, 1500);

  const res = await getStatus(ws);
  assert.equal(res.status, 200);
  const body = (await res.json()) as SiteStatus;

  assert.equal(body.workspaceId, ws);
  // pageviews comptés par l'agrégation ClickHouse réelle → service actif.
  assert.deepEqual(body.activeServices, ["pageviews"]);
  // Les autres services restent inactifs (V1 : forms/calls/gsc/ads/pagespeed
  // câblés à 0 — cf TODO dans tenant-status.ts).
  assert.deepEqual(
    body.inactiveServices,
    KNOWN_SERVICES.filter((s) => s !== "pageviews"),
  );
  assert.equal(body.counts.pageviews, 1500, "le count reflète les 1500 events");
  assert.equal(body.counts.forms, 0);
  assert.equal(body.counts.calls, 0);
  assert.equal(body.counts.gscRows, 0);
  assert.equal(body.counts.gscProperty, null);
});

// ─── 2. Workspace VIDE → tous les services inactifs ─────────────────────────

test("tenant-status: workspace vide → tous services inactifs", async () => {
  const ws = uniqueWorkspaceId("empty");
  // Aucun event seedé : ClickHouse comptera 0 pageviews.

  const res = await getStatus(ws);
  assert.equal(res.status, 200);
  const body = (await res.json()) as SiteStatus;

  assert.equal(body.workspaceId, ws);
  assert.deepEqual(body.activeServices, [], "aucun service actif");
  // L'ordre canonique de KNOWN_SERVICES est préservé (alimente l'UI shadow-mkt).
  assert.deepEqual(body.inactiveServices, [...KNOWN_SERVICES]);
  assert.equal(body.counts.pageviews, 0, "aucun pageview réel → 0");
});

// ─── 3. Le count pageviews est exact et scopé au bon workspace ──────────────

test("tenant-status: le count pageviews est scopé au workspace (agrégation CH réelle)", async () => {
  const wsA = uniqueWorkspaceId("scopeA");
  const wsB = uniqueWorkspaceId("scopeB");
  // Volumes distincts dans la même staminads.
  await staminads.seedPageviews(wsA, 7);
  await staminads.seedPageviews(wsB, 250);

  const a = (await (await getStatus(wsA)).json()) as SiteStatus;
  const b = (await (await getStatus(wsB)).json()) as SiteStatus;

  // Chaque workspace voit EXACTEMENT son propre volume — ClickHouse filtre
  // par workspace_id, aucune fuite entre tenants.
  assert.equal(a.counts.pageviews, 7);
  assert.equal(b.counts.pageviews, 250);
  assert.deepEqual(a.activeServices, ["pageviews"]);
  assert.deepEqual(b.activeServices, ["pageviews"]);
});

// ─── 4. Auth : sans Bearer → 401 ────────────────────────────────────────────

test("tenant-status: requête sans Bearer → 401 missing_bearer", async () => {
  const ws = uniqueWorkspaceId("noauth");
  await staminads.seedPageviews(ws, 100);
  const res = await getStatus(ws, false);
  assert.equal(res.status, 401);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "missing_bearer",
  );
});

// ─── 5. Auth : mauvaise clé → 403 ───────────────────────────────────────────

test("tenant-status: mauvaise clé Bearer → 403 invalid_admin_key", async () => {
  const ws = uniqueWorkspaceId("badkey");
  const res = await fetch(`${h.url}/api/admin/tenant/${ws}/status`, {
    headers: { Authorization: "Bearer not-the-real-admin-key" },
  });
  assert.equal(res.status, 403);
});
