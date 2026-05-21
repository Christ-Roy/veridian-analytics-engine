/**
 * Test 6/11 — provision Cas B : ré-attach idempotent.
 *
 * Même hubTenantId + même ownerEmail → refresh apiKey, retourne created:false,
 * tenant non dupliqué.
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

test("provision Cas B : 2e call même owner → created=false + même tenant_id", async () => {
  const payload = {
    tenant_id: "tnt-idem",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  };
  const r1 = await signedFetch(bridge.url, "POST", "/api/tenants/provision", payload);
  const b1 = (await r1.json()) as { created: boolean; api_key: string; workspace_id: string };
  assert.equal(b1.created, true);

  const r2 = await signedFetch(bridge.url, "POST", "/api/tenants/provision", payload);
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as { created: boolean; api_key: string; workspace_id: string; tenant_id: string };
  assert.equal(b2.created, false, "le 2e call doit retourner created:false");
  assert.equal(b2.tenant_id, "tnt-idem");

  // api_key refreshed (nouvelle clé) mais tenant pas dupliqué
  assert.notEqual(b2.api_key, b1.api_key, "api_key doit être refreshed");
  assert.equal(bridge.store._all().length, 1, "tenant ne doit pas être dupliqué");
});

test("provision Cas B : workspace_id stable entre Cas A et Cas B", async () => {
  const payload = {
    tenant_id: "tnt-stable",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  };
  const r1 = await signedFetch(bridge.url, "POST", "/api/tenants/provision", payload);
  const b1 = (await r1.json()) as { workspace_id: string };
  const r2 = await signedFetch(bridge.url, "POST", "/api/tenants/provision", payload);
  const b2 = (await r2.json()) as { workspace_id: string };
  // V1 : le workspace_id renvoyé en cas B vient du tenant DB existant
  // (pas du hook staminads qui pourrait re-créer un id différent).
  assert.equal(b2.workspace_id, b1.workspace_id);
});

test("provision Cas B : status reste 'active' après ré-attach", async () => {
  const payload = {
    tenant_id: "tnt-keepalive",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  };
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", payload);
  // Simulons une suspension
  bridge.store._setStatus("tnt-keepalive", "suspended");
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", payload);
  // V1 strict : provision ne réactive PAS un tenant suspendu (resume = endpoint séparé)
  const all = bridge.store._all();
  assert.equal(all[0].status, "suspended", "provision doit pas réactiver un tenant suspended");
});
