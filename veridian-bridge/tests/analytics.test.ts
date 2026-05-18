/**
 * Tests GET /api/admin/analytics.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { FakeStaminads, startAppOnEphemeralPort } from "./helpers/fake-staminads.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

let fake: FakeStaminads;
let bridgeUrl: string;
let closeBridge: () => Promise<void>;

beforeEach(async () => {
  fake = new FakeStaminads();
  await fake.start();
  const app = createApp({
    staminadsUrl: fake.url,
    adminEmail: "admin@veridian.local",
    adminPassword: "test-pass-2026",
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

test("analytics: happy path proxy 200", async () => {
  fake.setBehavior({ setupCompleted: true });
  const res = await getAnalytics("ws_fake_abc");
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    rows: Array<{ utm_source: string; pageviews: number; sessions: number }>;
  };
  assert.equal(body.rows[0].utm_source, "veridian-poc");
  assert.equal(body.rows[0].pageviews, 3);
});

test("analytics: wsId manquant → 400 missing_wsId", async () => {
  fake.setBehavior({ setupCompleted: true });
  const res = await getAnalytics(null);
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "missing_wsId");
});

test("analytics: wsId vide → 400 missing_wsId", async () => {
  fake.setBehavior({ setupCompleted: true });
  const res = await getAnalytics("");
  assert.equal(res.status, 400);
});

test("analytics: status staminads forwardé tel quel (200 → 200)", async () => {
  fake.setBehavior({ setupCompleted: true, analyticsStatus: 200 });
  const res = await getAnalytics("ws_fake_abc");
  assert.equal(res.status, 200);
});

test("analytics: status staminads forwardé tel quel (500 → 500)", async () => {
  fake.setBehavior({
    setupCompleted: true,
    analyticsStatus: 500,
    analyticsBody: { error: "clickhouse_down" },
  });
  const res = await getAnalytics("ws_fake_abc");
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "clickhouse_down");
});

test("analytics: payload query envoyé contient workspace_id + metrics + dimensions", async () => {
  fake.setBehavior({ setupCompleted: true });
  await getAnalytics("ws_xyz");
  const queryCall = fake.getCalls().find((c) => c.path === "/api/analytics.query");
  assert.ok(queryCall);
  const sent = queryCall.body as {
    workspace_id: string;
    metrics: string[];
    dimensions: string[];
    dateRange: { type: string };
  };
  // staminads DTO : workspace_id snake_case (cf openapi AnalyticsQueryDto)
  assert.equal(sent.workspace_id, "ws_xyz");
  assert.deepEqual(sent.metrics, ["pageviews", "sessions"]);
  assert.deepEqual(sent.dimensions, ["utm_source"]);
  assert.equal(sent.dateRange.type, "last_24_hours");
});

test("analytics: utilise admin token (Authorization header présent)", async () => {
  fake.setBehavior({ setupCompleted: true });
  await getAnalytics("ws_fake_abc");
  const queryCall = fake.getCalls().find((c) => c.path === "/api/analytics.query");
  assert.match(
    String(queryCall!.headers["authorization"]),
    /^Bearer fake-admin-token-from-(login|init)$/
  );
});
