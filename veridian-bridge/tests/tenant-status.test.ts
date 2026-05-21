/**
 * Tests GET /api/admin/tenant/:workspaceId/status
 *
 * Stratégie : on injecte un `pageviewsFetcher` mocké directement dans
 * createApp() au lieu de monter le fake-staminads. Plus rapide, plus
 * déterministe, et la couverture du chemin staminads réel reste assurée
 * par analytics.test.ts (qui exerce le même endpoint analytics.query).
 *
 * Les 3 cas du ticket :
 *   1. workspace vide (0 PV)  → tous services inactifs
 *   2. workspace avec 1500 PV → active = ['pageviews'], inactive = les 5 autres
 *   3. requête sans Bearer    → 401 missing_bearer
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { startAppOnEphemeralPort } from "./helpers/fake-staminads.js";
import {
  KNOWN_SERVICES,
  type PageviewsFetcher,
  type SiteStatus,
} from "../src/tenant-status.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

interface Ctx {
  url: string;
  close: () => Promise<void>;
  fetcher: PageviewsFetcher;
  fetcherCalls: string[];
}

async function bootBridge(pageviewsByWorkspace: Record<string, number>): Promise<Ctx> {
  const fetcherCalls: string[] = [];
  const fetcher: PageviewsFetcher = async (workspaceId) => {
    fetcherCalls.push(workspaceId);
    return pageviewsByWorkspace[workspaceId] ?? 0;
  };
  const app = createApp(
    {
      staminadsUrl: "http://127.0.0.1:1", // jamais appelé (fetcher injecté)
      adminEmail: "admin@veridian.local",
      adminPassword: "test-pass-2026",
      veridianAdminApiKey: ADMIN_KEY,
    },
    { pageviewsFetcher: fetcher },
  );
  const started = await startAppOnEphemeralPort(app);
  return { url: started.url, close: started.close, fetcher, fetcherCalls };
}

let ctx: Ctx;
afterEach(async () => {
  if (ctx) await ctx.close();
});

async function getStatus(workspaceId: string, withAuth = true) {
  return fetch(`${ctx.url}/api/admin/tenant/${workspaceId}/status`, {
    headers: withAuth ? { Authorization: `Bearer ${ADMIN_KEY}` } : {},
  });
}

test("tenant-status: workspace vide → tous services inactifs", async () => {
  ctx = await bootBridge({ ws_empty: 0 });
  const res = await getStatus("ws_empty");
  assert.equal(res.status, 200);
  const body = (await res.json()) as SiteStatus;
  assert.equal(body.workspaceId, "ws_empty");
  assert.deepEqual(body.activeServices, []);
  // L'ordre canonique de KNOWN_SERVICES doit être préservé dans inactiveServices
  // (UI shadow-marketing les affiche dans cet ordre).
  assert.deepEqual(body.inactiveServices, [...KNOWN_SERVICES]);
  assert.equal(body.counts.pageviews, 0);
  assert.equal(body.counts.forms, 0);
  assert.equal(body.counts.calls, 0);
  assert.equal(body.counts.gscRows, 0);
  assert.equal(body.counts.gscProperty, null);
  assert.equal(ctx.fetcherCalls.length, 1);
  assert.equal(ctx.fetcherCalls[0], "ws_empty");
});

test("tenant-status: 1500 PV → active=['pageviews'], inactive = les 5 autres", async () => {
  ctx = await bootBridge({ ws_live: 1500 });
  const res = await getStatus("ws_live");
  assert.equal(res.status, 200);
  const body = (await res.json()) as SiteStatus;
  assert.deepEqual(body.activeServices, ["pageviews"]);
  // Tous les autres services, dans l'ordre canonique, sans 'pageviews'.
  assert.deepEqual(
    body.inactiveServices,
    KNOWN_SERVICES.filter((s) => s !== "pageviews"),
  );
  assert.equal(body.counts.pageviews, 1500);
  // V1 : forms/calls/gsc/ads/pagespeed forcés à 0 + gscProperty null
  // (cf TODOs B1/A4 dans tenant-status.ts).
  assert.equal(body.counts.forms, 0);
  assert.equal(body.counts.calls, 0);
  assert.equal(body.counts.gscRows, 0);
  assert.equal(body.counts.gscClicks, 0);
  assert.equal(body.counts.gscImpressions, 0);
  assert.equal(body.counts.gscProperty, null);
});

test("tenant-status: sans Bearer → 401 missing_bearer", async () => {
  ctx = await bootBridge({ ws_any: 42 });
  const res = await getStatus("ws_any", false);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "missing_bearer");
  // Le fetcher ne doit jamais être appelé quand l'auth échoue.
  assert.equal(ctx.fetcherCalls.length, 0);
});

test("tenant-status: workspaceId vide dans le path → 404 Express (pas matché)", async () => {
  // Express ne match pas /api/admin/tenant//status (path param vide) →
  // c'est le routeur Express qui renvoie 404, pas notre handler. On vérifie
  // juste que la route est bien définie avec un param obligatoire.
  ctx = await bootBridge({});
  const res = await fetch(`${ctx.url}/api/admin/tenant//status`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(res.status, 404);
});

test("tenant-status: mauvaise clé Bearer → 403 invalid_admin_key", async () => {
  ctx = await bootBridge({ ws_any: 100 });
  const res = await fetch(`${ctx.url}/api/admin/tenant/ws_any/status`, {
    headers: { Authorization: "Bearer wrong-key" },
  });
  assert.equal(res.status, 403);
  assert.equal(ctx.fetcherCalls.length, 0);
});
