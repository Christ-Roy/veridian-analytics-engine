/**
 * Test 11/11 — paywall : tenant suspended → 402 sur endpoint protégé.
 *
 * Couvre directement la lib `requireActivePlan()` puisque ce ticket ne câble
 * pas encore d'endpoint user-facing (Pattern B Bearer api_key — repoussé en
 * S3). On vérifie que :
 *   - tenant active → laisse passer
 *   - tenant suspended → throw PaywallError(402, paywall_suspended)
 *   - tenant trial_expired → throw PaywallError(402, paywall_trial_expired)
 *   - tenant soft_deleted → throw PaywallError(402, paywall_soft_deleted)
 *   - tenant inexistant → throw Error générique (404 à gérer côté handler)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { requireActivePlan, PaywallError, isPlanActive } from "../../src/paywall.js";
import { InMemoryTenantStore } from "../../src/hub/store.js";

async function makeStoreWithTenant(status: string) {
  const store = new InMemoryTenantStore();
  const t = await store.create({
    hubTenantId: "tnt-pw",
    workspaceName: "PW Tenant",
    ownerEmail: "x@y.com",
    plan: "free",
    apiKey: "sk_x",
    staminadsWorkspaceId: "ws_pw",
  });
  if (status !== "active") {
    store._setStatus("tnt-pw", status);
  }
  return { store, tenantId: t.id };
}

test("paywall : tenant active → laisse passer (renvoie le record)", async () => {
  const { store, tenantId } = await makeStoreWithTenant("active");
  const t = await requireActivePlan(tenantId, store);
  assert.equal(t.status, "active");
});

test("paywall : tenant suspended → PaywallError(402, paywall_suspended)", async () => {
  const { store, tenantId } = await makeStoreWithTenant("suspended");
  await assert.rejects(
    () => requireActivePlan(tenantId, store),
    (err: unknown) => {
      assert.ok(err instanceof PaywallError);
      assert.equal(err.status, 402);
      assert.equal(err.code, "paywall_suspended");
      assert.equal(err.tenantId, tenantId);
      return true;
    }
  );
});

test("paywall : tenant trial_expired → PaywallError(402, paywall_trial_expired)", async () => {
  const { store, tenantId } = await makeStoreWithTenant("trial_expired");
  await assert.rejects(
    () => requireActivePlan(tenantId, store),
    (err: unknown) => {
      assert.ok(err instanceof PaywallError);
      assert.equal(err.code, "paywall_trial_expired");
      return true;
    }
  );
});

test("paywall : tenant soft_deleted → PaywallError(402, paywall_soft_deleted)", async () => {
  const { store, tenantId } = await makeStoreWithTenant("soft_deleted");
  await assert.rejects(
    () => requireActivePlan(tenantId, store),
    (err: unknown) => {
      assert.ok(err instanceof PaywallError);
      assert.equal(err.code, "paywall_soft_deleted");
      return true;
    }
  );
});

test("paywall : tenant inexistant → Error tenant_not_found (pas PaywallError)", async () => {
  const store = new InMemoryTenantStore();
  await assert.rejects(
    () => requireActivePlan("ghost", store),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(!(err instanceof PaywallError), "ne doit pas être un PaywallError");
      assert.match(err.message, /tenant_not_found/);
      return true;
    }
  );
});

test("paywall isPlanActive : helper non-throw", async () => {
  const store = new InMemoryTenantStore();
  const t = await store.create({
    hubTenantId: "tnt-helper",
    workspaceName: "X",
    ownerEmail: "x@y.com",
    plan: "free",
    apiKey: "k",
    staminadsWorkspaceId: "ws_h",
  });
  assert.equal(isPlanActive(t), true);
  store._setStatus("tnt-helper", "suspended");
  const updated = (await store.findByHubTenantId("tnt-helper"))!;
  assert.equal(isPlanActive(updated), false);
});
