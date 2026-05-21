/**
 * Test 7/11 — provision Cas C : conflit owner_email.
 *
 * Même hubTenantId mais owner_email différent → 409 tenant_conflict_owner.
 * Jamais d'écrasement silencieux (CONTRAT-HUB §5.1).
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

test("provision Cas C : owner_email différent → 409 tenant_conflict_owner", async () => {
  // 1er provision avec alice
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-conflict",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });

  // 2e provision avec bob sur le même tenant_id
  const r2 = await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-conflict",
    owner_email: "bob@example.com",
    workspace_name: "Alice",
    plan: "free",
  });
  assert.equal(r2.status, 409);
  const body = (await r2.json()) as { error: string; error_code: string };
  assert.equal(body.error, "tenant_conflict_owner");
  assert.equal(body.error_code, "conflict");
});

test("provision Cas C : owner_email original PRÉSERVÉ après conflit", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-no-overwrite",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-no-overwrite",
    owner_email: "eve@attacker.com",
    workspace_name: "Pwned",
    plan: "enterprise",
  });
  const all = bridge.store._all();
  assert.equal(all.length, 1);
  assert.equal(all[0].ownerEmail, "alice@example.com", "owner ne doit pas être écrasé");
  assert.equal(all[0].plan, "free", "plan ne doit pas être écrasé");
});

test("provision Cas C : staminads pas re-appelé sur conflit", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-no-staminads-call",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });
  bridge.resetStaminadsCalls();
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-no-staminads-call",
    owner_email: "eve@attacker.com",
    workspace_name: "Pwned",
    plan: "free",
  });
  assert.equal(
    bridge.staminadsCalls.length,
    0,
    "staminads ne doit pas être appelé sur conflit owner"
  );
});
