/**
 * Test 2/11 — signature HMAC invalide → 401.
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

test("hmac signature corrompue → 401 invalid_signature", async () => {
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    {
      tenant_id: "hub-tnt-fake",
      owner_email: "x@y.com",
      workspace_name: "X",
      plan: "free",
    },
    { signatureOverride: "deadbeef".repeat(8) /* 64 chars hex faux */ }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string; error_code: string };
  assert.equal(body.error, "unauthorized");
  assert.equal(body.error_code, "invalid_signature");
});

test("hmac signature absente → 401 missing_signature", async () => {
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    { tenant_id: "x", owner_email: "y@y.com", workspace_name: "Z", plan: "free" },
    { omitSignature: true }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "missing_signature");
});

test("hmac signature avec mauvais secret → 401", async () => {
  const res = await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    { tenant_id: "x", owner_email: "y@y.com", workspace_name: "Z", plan: "free" },
    { secret: "wrong-secret-totally-different!!" }
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "invalid_signature");
});

test("staminads pas appelé sur 401", async () => {
  await signedFetch(
    bridge.url,
    "POST",
    "/api/tenants/provision",
    { tenant_id: "x", owner_email: "y@y.com", workspace_name: "Z", plan: "free" },
    { signatureOverride: "0".repeat(64) }
  );
  assert.equal(bridge.staminadsCalls.length, 0);
});
