/**
 * E2E 02 — Tracker → ingestion → dashboard flow (golden path).
 *
 * Couvre le flow end-to-end :
 *   1. Tenant provisionné (Hub → bridge)
 *   2. Bridge expose `/api/admin/tenant/:workspaceId/status` (services actifs)
 *   3. Bridge expose `/api/admin/tenant/:workspaceId/score` (score Veridian)
 *
 * Le tracking réel (POST /api/track sur staminads) est mocké via le faux
 * staminads — on vérifie ici que le BRIDGE compose correctement les retours
 * staminads (analytics.query) en réponse côté UI.
 *
 * Le vrai tracker JS → staminads ingestion est testé par les e2e SDK upstream
 * (api/test/page-tracking.e2e-spec.ts) avec un vrai ClickHouse.
 *
 * Important : ce flow utilise `bootBridgeWithStaminads` (FakeStaminads HTTP
 * réel) — les routes admin `/status` et `/score` interrogent staminads via
 * `analytics.query`, contrairement aux autres specs qui se contentent du mock
 * de provision Hub.
 */

import { test, expect } from "@playwright/test";
import {
  bootBridgeWithStaminads,
  fakeHubTenantId,
  type BridgeFixture,
} from "../helpers/bridge-fixture.js";
import { VALID_PROVISION_PAYLOAD } from "../helpers/fixtures.js";

let bridge: BridgeFixture;
let workspaceId: string;

test.beforeAll(async () => {
  // Bridge câblé sur un FakeStaminads. analytics.query renvoie 1500 pageviews
  // 30j (via page_count/table pages) → service `pageviews` actif → score = 30.
  bridge = await bootBridgeWithStaminads();
  bridge.staminads!.setBehavior({
    analyticsStatus: 200,
    analyticsBodyByTable: {
      pages: { data: [{ page_count: 1500 }] },
      goals: { data: [{ goals: 0 }] },
    },
  });

  // Provision un tenant pour les tests de dashboard
  const tenantId = fakeHubTenantId("dashboard");
  const res = await bridge.signedFetch("POST", "/api/tenants/provision", {
    ...VALID_PROVISION_PAYLOAD,
    tenant_id: tenantId,
    workspace_name: "Dashboard Test",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  workspaceId = body.workspace_id ?? "ws_fake_1";
});

test.afterAll(async () => {
  await bridge?.close();
});

test.describe("Dashboard endpoints — Bearer auth", () => {
  test("GET /api/admin/tenant/:workspaceId/status sans Bearer → 401", async () => {
    const res = await fetch(`${bridge.url}/api/admin/tenant/${workspaceId}/status`);
    expect(res.status).toBe(401);
  });

  test("GET /api/admin/tenant/:workspaceId/status avec Bearer valide → 200 + services", async () => {
    const res = await bridge.adminFetch(
      "GET",
      `/api/admin/tenant/${workspaceId}/status`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("workspaceId");
    expect(body).toHaveProperty("activeServices");
    expect(body).toHaveProperty("inactiveServices");
    expect(body).toHaveProperty("counts");
    // pageviews actif (1500 PV depuis fake staminads), les autres inactifs
    // tant que B1/A4 pas livrés.
    expect(body.activeServices).toContain("pageviews");
    expect(body.counts.pageviews).toBe(1500);
    expect(body.inactiveServices).toEqual(
      expect.arrayContaining(["forms", "calls", "gsc", "ads", "pagespeed"])
    );
  });
});

test.describe("Score Veridian — composante du dashboard", () => {
  test("GET /api/admin/tenant/:workspaceId/score avec Bearer → 200 + score + label", async () => {
    const res = await bridge.adminFetch(
      "GET",
      `/api/admin/tenant/${workspaceId}/score`
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("score");
    expect(body).toHaveProperty("label");
    expect(typeof body.score).toBe("number");
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    // pageviews actif uniquement → poids 30 → score 30 → "À améliorer".
    expect(body.score).toBe(30);
    expect(["Excellent", "Très bon", "Bon", "À améliorer", "À démarrer"]).toContain(
      body.label
    );
    expect(body.label).toBe("À améliorer");
    expect(body.services.active).toContain("pageviews");
  });

  test("GET /api/admin/tenant/:workspaceId/score sans Bearer → 401", async () => {
    const res = await fetch(`${bridge.url}/api/admin/tenant/${workspaceId}/score`);
    expect(res.status).toBe(401);
  });
});

test.describe("Tenant inexistant", () => {
  test("GET /api/admin/tenant/inexistant/status → 200 (PV via fetcher tolérant)", async () => {
    // Le pageviewsFetcher swallow les erreurs staminads et renvoie 0 → le
    // builder rend un status plutôt qu'un 404 strict. Ici staminads répond
    // toujours 200 (workspace pas matché côté fake → analyticsBody par défaut).
    const res = await bridge.adminFetch(
      "GET",
      "/api/admin/tenant/ws_does_not_exist/status"
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("workspaceId", "ws_does_not_exist");
    expect(body).toHaveProperty("activeServices");
  });

  test("GET /api/admin/tenant/inexistant/score → 404 si staminads dit workspace inconnu", async () => {
    // analytics.query renvoie 404 → le bridge traduit en 404 workspace_not_found.
    bridge.staminads!.setBehavior({
      analyticsStatus: 404,
      analyticsBody: { error: "workspace_not_found" },
    });
    const res = await bridge.adminFetch(
      "GET",
      "/api/admin/tenant/ws_does_not_exist/score"
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("workspace_not_found");

    // Restore le comportement par défaut pour ne pas polluer d'autres tests.
    bridge.staminads!.setBehavior({
      analyticsStatus: 200,
      analyticsBodyByTable: {
        pages: { data: [{ page_count: 1500 }] },
        goals: { data: [{ goals: 0 }] },
      },
    });
  });
});
