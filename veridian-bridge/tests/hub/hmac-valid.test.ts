/**
 * Test 1/11 — HMAC valide → request passe.
 *
 * Vérifie le happy path : timestamp + signature corrects → 200.
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

test("hmac valide : POST /api/tenants/provision → 200", async () => {
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "hub-tnt-123",
    owner_email: "alice@example.com",
    workspace_name: "Alice Site",
    plan: "free",
  });
  const text = await res.text();
  assert.equal(res.status, 200, `expected 200, got ${res.status} : ${text}`);
  const body = JSON.parse(text) as { created: boolean; tenant_id: string };
  assert.equal(body.created, true);
  assert.equal(body.tenant_id, "hub-tnt-123");
});

test("hmac valide : GET /api/tenants/:id/health avec body vide → 200", async () => {
  // D'abord on provisionne
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "hub-tnt-h1",
    owner_email: "bob@example.com",
    workspace_name: "Bob",
    plan: "pro",
  });

  // GET avec body vide → la signature est sur "" donc OK
  const res = await signedFetch(
    bridge.url,
    "GET",
    "/api/tenants/hub-tnt-h1/health",
    undefined
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; tenant_id: string };
  assert.equal(body.tenant_id, "hub-tnt-h1");
  assert.equal(body.status, "active");
});
