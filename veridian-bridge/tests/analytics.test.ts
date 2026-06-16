/**
 * Tests GET /api/admin/analytics.
 *
 * Depuis la migration M2M (2026-06-16) : lit l'Engine via
 * `POST /api/admin/platform/analytics.query` (Bearer PLATFORM_ADMIN_API_KEY),
 * contrat NATIF (preset date range, réponse { data, meta }).
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeStaminads, startAppOnEphemeralPort } from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";
const PLATFORM_KEY = "veridian-test-platform-key-32-chars!!";

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

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

async function getAnalytics(wsId: string | null) {
  const url =
    wsId === null ? `${bridgeUrl}/api/admin/analytics` : `${bridgeUrl}/api/admin/analytics?wsId=${wsId}`;
  return fetch(url, {
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
}

test("analytics: happy path → renvoie { data } natif", async () => {
  const res = await getAnalytics("ws_fake_abc");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    data: Array<{ utm_source: string; pageviews: number; sessions: number }>;
  };
  assert.equal(body.data[0].utm_source, "veridian-poc");
  assert.equal(body.data[0].pageviews, 3);
});

test("analytics: wsId manquant → 400 missing_wsId", async () => {
  const res = await getAnalytics(null);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "missing_wsId");
});

test("analytics: wsId vide → 400 missing_wsId", async () => {
  const res = await getAnalytics("");
  assert.equal(res.status, 400);
});

test("analytics: erreur Engine (500) → 502 analytics_query_failed", async () => {
  fake.setBehavior({
    analyticsStatus: 500,
    analyticsBody: { error: "clickhouse_down" },
  });
  const res = await getAnalytics("ws_fake_abc");
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; status: number };
  assert.equal(body.error, "analytics_query_failed");
  assert.equal(body.status, 500);
});

test("analytics: query native = workspace_id + metrics + dimensions + preset + table", async () => {
  await getAnalytics("ws_xyz");
  const queryCall = fake
    .getCalls()
    .find((c) => c.path === "/api/admin/platform/analytics.query");
  assert.ok(queryCall);
  const sent = queryCall.body as {
    workspace_id: string;
    metrics: string[];
    dimensions: string[];
    dateRange: { preset: string };
    table: string;
  };
  assert.equal(sent.workspace_id, "ws_xyz");
  assert.deepEqual(sent.metrics, ["pageviews", "sessions"]);
  assert.deepEqual(sent.dimensions, ["utm_source"]);
  // Contrat natif : preset (PAS le legacy { type }).
  assert.equal(sent.dateRange.preset, "today");
  assert.equal(sent.table, "sessions");
});

test("analytics: appelle le natif avec Bearer PLATFORM_ADMIN_API_KEY", async () => {
  await getAnalytics("ws_fake_abc");
  const queryCall = fake
    .getCalls()
    .find((c) => c.path === "/api/admin/platform/analytics.query");
  assert.equal(queryCall!.headers["authorization"], `Bearer ${PLATFORM_KEY}`);
});
