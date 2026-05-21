/**
 * Test 9/11 — attach-owner idempotent.
 *
 * Rappeler attach-owner avec exactement les mêmes (tenant_id, owner_email,
 * user_id) → already_attached:true au 2e call.
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

test("attach-owner idempotent : 2e call identique → already_attached=true", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-idem-att",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });

  const payload = {
    tenant_id: "tnt-idem-att",
    owner_email: "alice@example.com",
    user_id: "usr_alice",
  };

  const r1 = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", payload);
  const b1 = (await r1.json()) as { already_attached: boolean };
  assert.equal(b1.already_attached, false, "1er call : already_attached=false");

  const r2 = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", payload);
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as { already_attached: boolean; attached: boolean };
  assert.equal(b2.already_attached, true, "2e call : already_attached=true");
  assert.equal(b2.attached, true);
});

test("attach-owner : changement user_id (même email) → already_attached=false", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-userid-change",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });

  await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-userid-change",
    owner_email: "alice@example.com",
    user_id: "usr_alice_old",
  });

  const r2 = await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-userid-change",
    owner_email: "alice@example.com",
    user_id: "usr_alice_new",
  });
  const b2 = (await r2.json()) as { already_attached: boolean; user_id: string };
  assert.equal(b2.already_attached, false);
  assert.equal(b2.user_id, "usr_alice_new");
});
