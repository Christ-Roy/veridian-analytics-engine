/**
 * Test 10/11 — GET /api/tenants/:id/health.
 *
 * Vérifie payload : status, last_event_at, sites_count, pageviews_30d,
 * owner_attached, magic_link_capable, api_key_valid.
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

test("health : tenant actif fraîchement provisionné", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-health-fresh",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "pro",
  });

  const res = await signedFetch(
    bridge.url,
    "GET",
    "/api/tenants/tnt-health-fresh/health",
    undefined
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    tenant_id: string;
    status: string;
    plan: string;
    owner_attached: boolean;
    magic_link_capable: boolean;
    api_key_valid: boolean;
    last_event_at: string | null;
    sites_count: number;
    pageviews_30d: number;
    checked_at: string;
  };
  assert.equal(body.tenant_id, "tnt-health-fresh");
  assert.equal(body.status, "active");
  assert.equal(body.plan, "pro");
  // Pas d'attach-owner appelé → owner_attached false (ownerUserId null)
  assert.equal(body.owner_attached, false);
  assert.equal(body.magic_link_capable, false);
  assert.equal(body.api_key_valid, true);
  assert.equal(body.last_event_at, null);
  assert.equal(body.sites_count, 0);
  assert.equal(body.pageviews_30d, 0);
  assert.match(body.checked_at, /^\d{4}-\d{2}-\d{2}T/);
});

test("health : après attach-owner → magic_link_capable=true", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-h-attached",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "free",
  });
  await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-h-attached",
    owner_email: "alice@example.com",
    user_id: "usr_a",
  });

  const res = await signedFetch(bridge.url, "GET", "/api/tenants/tnt-h-attached/health", undefined);
  const body = (await res.json()) as {
    owner_attached: boolean;
    magic_link_capable: boolean;
  };
  assert.equal(body.owner_attached, true);
  assert.equal(body.magic_link_capable, true);
});

test("health : stats remontent depuis loadStats hook", async () => {
  await bridge.close();
  bridge = await createHubBridge({
    loadStats: async () => ({
      lastEventAt: new Date("2026-05-20T10:00:00Z"),
      sitesCount: 3,
      pageviews30d: 4567,
    }),
  });
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-stats",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "pro",
  });

  const res = await signedFetch(bridge.url, "GET", "/api/tenants/tnt-stats/health", undefined);
  const body = (await res.json()) as {
    last_event_at: string | null;
    sites_count: number;
    pageviews_30d: number;
  };
  assert.equal(body.last_event_at, "2026-05-20T10:00:00.000Z");
  assert.equal(body.sites_count, 3);
  assert.equal(body.pageviews_30d, 4567);
});

test("health : tenant inexistant → 404 tenant_not_found", async () => {
  const res = await signedFetch(
    bridge.url,
    "GET",
    "/api/tenants/tnt-ghost/health",
    undefined
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "tenant_not_found");
});

test("health : tenant suspended → status=suspended + magic_link_capable=false", async () => {
  await signedFetch(bridge.url, "POST", "/api/tenants/provision", {
    tenant_id: "tnt-h-susp",
    owner_email: "alice@example.com",
    workspace_name: "Alice",
    plan: "pro",
  });
  await signedFetch(bridge.url, "POST", "/api/tenants/attach-owner", {
    tenant_id: "tnt-h-susp",
    owner_email: "alice@example.com",
    user_id: "u",
  });
  bridge.store._setStatus("tnt-h-susp", "suspended");

  const res = await signedFetch(bridge.url, "GET", "/api/tenants/tnt-h-susp/health", undefined);
  const body = (await res.json()) as {
    status: string;
    magic_link_capable: boolean;
    owner_attached: boolean;
  };
  assert.equal(body.status, "suspended");
  assert.equal(body.owner_attached, true);
  // Status != active → pas magic-link capable même si owner attaché
  assert.equal(body.magic_link_capable, false);
});
