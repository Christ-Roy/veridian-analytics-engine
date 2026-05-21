/**
 * Test 8/11 — attach-owner happy path.
 *
 * Attache un user à un tenant existant. Le tenant doit avoir été provisionné
 * avant (sinon 404).
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

test("attach-owner : tenant existant → 200 attached=true", async () => {
  // Provision d'abord
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-attach",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });

  const res = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-attach",
    owner_email: "alice@example.com",
    user_id: "usr_alice_hub",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    attached: boolean;
    already_attached: boolean;
    user_id: string;
    role: string;
  };
  assert.equal(body.attached, true);
  assert.equal(body.already_attached, false);
  assert.equal(body.user_id, "usr_alice_hub");
  assert.equal(body.role, "owner");

  // Vérif persistance
  const t = bridge.store._all()[0];
  assert.equal(t.ownerEmail, "alice@example.com");
  assert.equal(t.ownerUserId, "usr_alice_hub");
});

test("attach-owner : tenant inexistant → 404 tenant_not_found", async () => {
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-ghost",
    owner_email: "ghost@example.com",
    user_id: "usr_ghost",
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "tenant_not_found");
});

test("attach-owner : user_id auto-généré depuis email si absent", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-no-uid",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-no-uid",
    owner_email: "alice@example.com",
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { user_id: string };
  assert.match(body.user_id, /^usr_/);
});

test("attach-owner : role=admin → renvoyé tel quel", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-admin-role",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });
  const res = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-admin-role",
    owner_email: "alice@example.com",
    user_id: "u1",
    role: "admin",
  });
  const body = (await res.json()) as { role: string };
  assert.equal(body.role, "admin");
});
