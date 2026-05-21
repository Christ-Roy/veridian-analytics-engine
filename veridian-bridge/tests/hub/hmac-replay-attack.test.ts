/**
 * Test 3/11 — anti-replay timestamp > 5min → 401 timestamp_drift.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHubBridge, signedFetch, type HubBridgeFixture } from "./helpers.js";

let bridge: HubBridgeFixture;

beforeEach(async () => {
  bridge = await createHubBridge();
});

afterEach(async () => {
  await bridge.close();
});

test("timestamp > 5min dans le passé → 401 timestamp_drift", async () => {
  const tenMinAgo = Date.now() - 10 * 60 * 1000;
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "old-tnt",
      owner_email: "x@y.com",
      workspace_name: "X",
      plan: "free",
    },
    { timestampOverride: tenMinAgo }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "timestamp_drift");
});

test("timestamp > 5min dans le futur → 401 timestamp_drift", async () => {
  const tenMinFuture = Date.now() + 10 * 60 * 1000;
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "future-tnt",
      owner_email: "x@y.com",
      workspace_name: "X",
      plan: "free",
    },
    { timestampOverride: tenMinFuture }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "timestamp_drift");
});

test("timestamp absent → 401 missing_timestamp", async () => {
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    { tenant_id: "x", owner_email: "y@y.com", workspace_name: "Z", plan: "free" },
    { omitTimestamp: true }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "missing_timestamp");
});

test("timestamp non-numérique → 401 invalid_timestamp", async () => {
  // On reproduit la requête manuellement pour insérer un ts texte
  const rawBody = JSON.stringify({
    tenant_id: "x",
    owner_email: "y@y.com",
    workspace_name: "Z",
    plan: "free",
  });
  const res = await fetch(`${bridge.url}/api/tenants/provision`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Veridian-Timestamp": "not-a-number",
      "X-Veridian-Hub-Signature": "00".repeat(32),
    },
    body: rawBody,
  });
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "invalid_timestamp");
});

test("timestamp 4min59s (limite) → OK 200", async () => {
  const justUnder = Date.now() - 4 * 60 * 1000 - 59_000;
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "edge-tnt",
      owner_email: "x@y.com",
      workspace_name: "X",
      plan: "free",
    },
    { timestampOverride: justUnder }
  );
  assert.equal(res.status, 200, `expected 200 at 4m59s drift, got ${res.status}`);
});
