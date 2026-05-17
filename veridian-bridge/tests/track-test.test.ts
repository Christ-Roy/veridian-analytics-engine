/**
 * Tests POST /api/admin/track-test.
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

async function trackTest(body: unknown) {
  return fetch(`${bridgeUrl}/api/admin/track-test`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_KEY}`,
    },
    body: JSON.stringify(body),
  });
}

test("track-test: happy path 200 ok + actionsSent correct", async () => {
  const res = await trackTest({
    workspaceId: "ws_fake_abc",
    sessionId: "sess-1",
    paths: ["/", "/pricing", "/signup"],
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    sessionId: string;
    actionsSent: number;
  };
  assert.equal(body.ok, true);
  assert.equal(body.sessionId, "sess-1");
  // 3 pageviews + 1 goal
  assert.equal(body.actionsSent, 4);
});

test("track-test: workspaceId manquant → 400", async () => {
  const res = await trackTest({ paths: ["/"] });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_body");
});

test("track-test: paths défaut si omis", async () => {
  const res = await trackTest({ workspaceId: "ws_fake_abc" });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { actionsSent: number };
  // 3 paths par défaut (/ /pricing /contact) + 1 goal
  assert.equal(body.actionsSent, 4);
});

test("track-test: sessionId généré si omis", async () => {
  const res = await trackTest({ workspaceId: "ws_fake_abc" });
  const body = (await res.json()) as { sessionId: string };
  assert.match(body.sessionId, /^poc-sess-\d+$/);
});

test("track-test: staminads track échoue → 502 track_failed", async () => {
  fake.setBehavior({ trackStatus: 400, trackBody: { error: "invalid_payload" } });
  const res = await trackTest({ workspaceId: "ws_fake_abc" });
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string; status: number };
  assert.equal(body.error, "track_failed");
  assert.equal(body.status, 400);
});

test("track-test: payload envoyé contient les UTM Veridian", async () => {
  await trackTest({ workspaceId: "ws_fake_abc", paths: ["/", "/pricing"] });
  const trackCall = fake.getCalls().find((c) => c.path === "/api/track");
  assert.ok(trackCall);
  const sent = trackCall.body as {
    workspace_id: string;
    actions: Array<{ type: string }>;
    attributes: { utm_source: string; utm_campaign: string };
  };
  assert.equal(sent.workspace_id, "ws_fake_abc");
  assert.equal(sent.attributes.utm_source, "veridian-poc");
  assert.equal(sent.attributes.utm_campaign, "engine-validation");
});

test("track-test: les actions contiennent les bons types (pageview x N + 1 goal)", async () => {
  await trackTest({ workspaceId: "ws_fake_abc", paths: ["/", "/a", "/b"] });
  const trackCall = fake.getCalls().find((c) => c.path === "/api/track");
  const sent = trackCall!.body as { actions: Array<{ type: string }> };
  const types = sent.actions.map((a) => a.type);
  assert.deepEqual(types, ["pageview", "pageview", "pageview", "goal"]);
});

test("track-test: pageview a entered_at < exited_at (invariant SDK staminads)", async () => {
  await trackTest({ workspaceId: "ws_fake_abc" });
  const trackCall = fake.getCalls().find((c) => c.path === "/api/track");
  const sent = trackCall!.body as {
    actions: Array<{ type: string; entered_at?: number; exited_at?: number }>;
  };
  for (const a of sent.actions) {
    if (a.type === "pageview") {
      assert.ok(typeof a.entered_at === "number");
      assert.ok(typeof a.exited_at === "number");
      assert.ok(
        a.entered_at! <= a.exited_at!,
        "entered_at doit être <= exited_at (invariant staminads)"
      );
    }
  }
});

test("track-test: headers origin + referer envoyés à staminads", async () => {
  await trackTest({ workspaceId: "ws_fake_abc" });
  const trackCall = fake.getCalls().find((c) => c.path === "/api/track");
  assert.ok(trackCall);
  assert.equal(trackCall.headers["origin"], "https://demo.veridian.site");
  assert.equal(trackCall.headers["referer"], "https://demo.veridian.site/");
});
