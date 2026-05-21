/**
 * Test 5/11 — provision Cas A : nouveau tenant.
 *
 * Vérifie que :
 *   - row Tenant créée
 *   - apiKey staminads retournée
 *   - hook staminads appelé une fois avec les bons inputs
 *   - réponse contient created:true + dashboard_url + plan echo
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

test("provision Cas A : nouveau tenant → 200 created=true + apiKey", async () => {
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-new-1",
    owner_email: "alice@example.com",
    workspace_name: "Alice Analytics",
    plan: "pro",
    metadata: { hub_user_id: "usr_h1" },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    tenant_id: string;
    workspace_id: string;
    api_key: string;
    api_key_email: string;
    plan: string;
    created: boolean;
    owner_email: string;
    dashboard_url: string;
  };
  assert.equal(body.tenant_id, "tnt-new-1");
  assert.equal(body.created, true);
  assert.equal(body.plan, "pro");
  assert.equal(body.owner_email, "alice@example.com");
  assert.match(body.api_key, /^sk_fake_/);
  assert.match(body.workspace_id, /^ws_fake_/);
  assert.match(body.dashboard_url, /^https?:\/\//);
  assert.match(body.api_key_email, /^bot\+/);
});

test("provision Cas A : tenant persisté avec status=active", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-persisted",
    owner_email: "bob@example.com",
    workspace_name: "Bob",
    plan: "free",
  });
  const all = bridge.store._all();
  assert.equal(all.length, 1);
  assert.equal(all[0].hubTenantId, "tnt-persisted");
  assert.equal(all[0].status, "active");
  assert.equal(all[0].ownerEmail, "bob@example.com");
  assert.equal(all[0].plan, "free");
});

test("provision Cas A : hook staminads appelé avec hubTenantId + ownerEmail", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-stamcheck",
    owner_email: "carol@example.com",
    workspace_name: "Carol Co",
    plan: "business",
  });
  assert.equal(bridge.staminadsCalls.length, 1);
  assert.deepEqual(bridge.staminadsCalls[0], {
    hubTenantId: "tnt-stamcheck",
    workspaceName: "Carol Co",
    ownerEmail: "carol@example.com",
  });
});

test("provision Cas A : plan invalide → 400 validation_failed", async () => {
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-bad-plan",
    owner_email: "x@y.com",
    workspace_name: "X",
    plan: "platinum_unicorn",
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_body");
});

test("provision Cas A : owner_email invalide → 400", async () => {
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-bad-email",
    owner_email: "not-an-email",
    workspace_name: "X",
    plan: "free",
  });
  assert.equal(res.status, 400);
});
