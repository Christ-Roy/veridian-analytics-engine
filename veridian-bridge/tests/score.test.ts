/**
 * Tests Score Veridian — pondération + label + endpoint admin.
 *
 * Le coeur de la lib (`computeScore`, `scoreLabel`, `buildCountsFromStaminadsRows`)
 * est testé en unité (pas de réseau). L'endpoint `/api/admin/tenant/:wsId/score`
 * est testé en intégration via le faux staminads partagé.
 *
 * Cas obligatoires (ticket A1) :
 *   - Workspace sans data → score 0, label "À démarrer", active vide
 *   - Workspace 1500 pageviews, 0 forms → score 30, label "À améliorer"
 *   - Workspace pageviews + forms + gsc mocked → score 70, label "Très bon"
 *   - Endpoint sans Bearer → 401
 *   - Endpoint workspace inconnu → 404
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import {
  buildCountsFromStaminadsRows,
  computeScore,
  scoreLabel,
  type ServiceCounts,
} from "../src/score.js";
import {
  FakeStaminads,
  startAppOnEphemeralPort,
} from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

// Counts baseline V1 : calls/gsc/ads/pagespeed à 0 (cf TODO score.ts).
function baseCounts(overrides: Partial<ServiceCounts> = {}): ServiceCounts {
  return {
    pageviews: 0,
    forms: 0,
    calls: 0,
    gsc: 0,
    ads: 0,
    pagespeed: 0,
    ...overrides,
  };
}

// ─── computeScore : pondération ───────────────────────────────────────────

test("score: workspace sans data → 0, À démarrer, active vide", () => {
  const result = computeScore(baseCounts());
  assert.equal(result.score, 0);
  assert.equal(result.label, "À démarrer");
  assert.deepEqual(result.services.active, []);
  assert.deepEqual(result.services.inactive, [
    "pageviews",
    "forms",
    "calls",
    "gsc",
    "ads",
    "pagespeed",
  ]);
});

test("score: 1500 pageviews + 0 forms → 30, À améliorer", () => {
  const result = computeScore(baseCounts({ pageviews: 1500 }));
  assert.equal(result.score, 30);
  assert.equal(result.label, "À améliorer");
  assert.deepEqual(result.services.active, ["pageviews"]);
});

test("score: pageviews + forms + gsc → 70, Très bon", () => {
  // 30 (pv) + 20 (forms) + 20 (gsc) = 70 → "Très bon"
  const result = computeScore(
    baseCounts({ pageviews: 1000, forms: 5, gsc: 12 }),
  );
  assert.equal(result.score, 70);
  assert.equal(result.label, "Très bon");
  assert.deepEqual(result.services.active, ["pageviews", "forms", "gsc"]);
  assert.deepEqual(result.services.inactive, ["calls", "ads", "pagespeed"]);
});

test("score: tous services actifs → capé à 100, Excellent", () => {
  // 30 + 20 + 20 + 20 + 5 + 5 = 100 → "Excellent"
  const result = computeScore(
    baseCounts({
      pageviews: 1,
      forms: 1,
      calls: 1,
      gsc: 1,
      ads: 1,
      pagespeed: 1,
    }),
  );
  assert.equal(result.score, 100);
  assert.equal(result.label, "Excellent");
});

test("score: pageviews + forms + calls → 70, Très bon (palier 70+)", () => {
  // 30 + 20 + 20 = 70
  const result = computeScore(
    baseCounts({ pageviews: 100, forms: 3, calls: 1 }),
  );
  assert.equal(result.score, 70);
  assert.equal(result.label, "Très bon");
});

// ─── scoreLabel : seuils ──────────────────────────────────────────────────

test("scoreLabel: seuils respectent la spec ticket A1", () => {
  assert.equal(scoreLabel(0), "À démarrer");
  assert.equal(scoreLabel(29), "À démarrer");
  assert.equal(scoreLabel(30), "À améliorer");
  assert.equal(scoreLabel(49), "À améliorer");
  assert.equal(scoreLabel(50), "Bon");
  assert.equal(scoreLabel(69), "Bon");
  assert.equal(scoreLabel(70), "Très bon");
  assert.equal(scoreLabel(89), "Très bon");
  assert.equal(scoreLabel(90), "Excellent");
  assert.equal(scoreLabel(100), "Excellent");
});

// ─── buildCountsFromStaminadsRows : agrégation ────────────────────────────

test("buildCountsFromStaminadsRows: vide → tout à 0", () => {
  const counts = buildCountsFromStaminadsRows([]);
  assert.deepEqual(counts, baseCounts());
});

test("buildCountsFromStaminadsRows: somme pageviews + goals", () => {
  const counts = buildCountsFromStaminadsRows([
    { pageviews: 1200, goals: 3 },
    { pageviews: 300, goals: 0 },
  ]);
  assert.equal(counts.pageviews, 1500);
  assert.equal(counts.forms, 3);
  // V1 toujours 0
  assert.equal(counts.calls, 0);
  assert.equal(counts.gsc, 0);
  assert.equal(counts.ads, 0);
  assert.equal(counts.pagespeed, 0);
});

test("buildCountsFromStaminadsRows: ignore les valeurs non numériques", () => {
  const counts = buildCountsFromStaminadsRows([
    { pageviews: "oops" as unknown as number, goals: 5 },
    { pageviews: 10, goals: null as unknown as number },
  ]);
  assert.equal(counts.pageviews, 10);
  assert.equal(counts.forms, 5);
});

// ─── Endpoint /api/admin/tenant/:workspaceId/score ────────────────────────

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

const PLATFORM_KEY = "veridian-test-platform-key-32-chars!!";

beforeEach(async () => {
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
    platformAdminApiKey: PLATFORM_KEY,
    veridianAdminApiKey: ADMIN_KEY,
  });
  const started = await startAppOnEphemeralPort(app);
  bridgeUrl = started.url;
  closeBridge = started.close;
});

afterEach(async () => {
  await closeBridge();
  await fake.stop();
});

test("endpoint: sans Bearer → 401 missing_bearer", async () => {
  const res = await fetch(`${bridgeUrl}/api/admin/tenant/ws_xyz/score`);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "missing_bearer");
});

test("endpoint: mauvaise clé Bearer → 403 invalid_admin_key", async () => {
  const res = await fetch(`${bridgeUrl}/api/admin/tenant/ws_xyz/score`, {
    headers: { Authorization: "Bearer wrong-key" },
  });
  assert.equal(res.status, 403);
});

test("endpoint: workspace inconnu (Engine 404) → 404 workspace_not_found", async () => {
  fake.setBehavior({
    analyticsStatus: 404,
    analyticsBody: { error: "workspace not found" },
  });
  const res = await fetch(
    `${bridgeUrl}/api/admin/tenant/ws_unknown/score`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string; workspaceId: string };
  assert.equal(body.error, "workspace_not_found");
  assert.equal(body.workspaceId, "ws_unknown");
});

test("endpoint: workspace inconnu (Engine 400) → 404 workspace_not_found", async () => {
  // L'Engine peut renvoyer 400 si le workspace_id est mal formé / absent.
  // On traduit en 404 propre côté bridge pour l'appelant.
  fake.setBehavior({
    analyticsStatus: 400,
    analyticsBody: { error: "bad request" },
  });
  const res = await fetch(
    `${bridgeUrl}/api/admin/tenant/ws_bad/score`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 404);
});

test("endpoint: happy path renvoie score + label + services", async () => {
  // 2 queries natives : sessions → pageviews, goals → goals.
  fake.setBehavior({
    analyticsStatus: 200,
    analyticsBodyByTable: {
      sessions: { data: [{ pageviews: 1500 }] },
      goals: { data: [{ goals: 3 }] },
    },
  });
  const res = await fetch(
    `${bridgeUrl}/api/admin/tenant/ws_demo/score`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    workspaceId: string;
    score: number;
    label: string;
    services: { active: string[]; inactive: string[] };
  };
  assert.equal(body.workspaceId, "ws_demo");
  // pageviews(30) + forms(20, proxy goals) = 50 → "Bon"
  assert.equal(body.score, 50);
  assert.equal(body.label, "Bon");
  assert.deepEqual(body.services.active, ["pageviews", "forms"]);
});

test("endpoint: data vides → score 0, label À démarrer", async () => {
  fake.setBehavior({
    analyticsStatus: 200,
    analyticsBody: { data: [] },
  });
  const res = await fetch(
    `${bridgeUrl}/api/admin/tenant/ws_zero/score`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { score: number; label: string };
  assert.equal(body.score, 0);
  assert.equal(body.label, "À démarrer");
});

test("endpoint: Engine 500 → 502 analytics_query_failed", async () => {
  fake.setBehavior({
    analyticsStatus: 500,
    analyticsBody: { error: "clickhouse_down" },
  });
  const res = await fetch(
    `${bridgeUrl}/api/admin/tenant/ws_demo/score`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "analytics_query_failed");
});

test("endpoint: 2 queries natives (sessions+goals) avec preset 30j + Bearer M2M", async () => {
  fake.setBehavior({
    analyticsStatus: 200,
    analyticsBodyByTable: {
      sessions: { data: [{ pageviews: 100 }] },
      goals: { data: [{ goals: 1 }] },
    },
  });
  await fetch(`${bridgeUrl}/api/admin/tenant/ws_check/score`, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  const queries = fake
    .getCalls()
    .filter((c) => c.path === "/api/admin/platform/analytics.query");
  assert.equal(queries.length, 2, "le score doit faire 2 queries (1 par table)");

  for (const q of queries) {
    assert.equal(q.headers["authorization"], `Bearer ${PLATFORM_KEY}`);
    const sent = q.body as {
      workspace_id: string;
      dateRange: { preset: string };
      table: string;
    };
    assert.equal(sent.workspace_id, "ws_check");
    assert.equal(sent.dateRange.preset, "previous_30_days");
  }
  const tables = queries.map((q) => (q.body as { table: string }).table).sort();
  assert.deepEqual(tables, ["goals", "sessions"]);
});
