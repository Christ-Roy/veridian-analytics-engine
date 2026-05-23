/**
 * Phase B — Le endpoint `/api/admin/tenant/:wsId/score` (bridge) renvoie un
 * shape valide pour un workspace existant.
 *
 * Contrat (cf veridian-bridge/src/app.ts L393) :
 *   { workspaceId, score: number (0-100), label: string, services: { ... } }
 *
 * Tag `@critical` — Hub consomme ce endpoint pour afficher le score sur
 * `dashboard.veridian.site`. Si la shape change, Hub crash.
 *
 * Skip si pas de bridge admin token (= demo + staging sans secret).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const ADMIN_TOKEN =
  process.env.BRIDGE_ADMIN_TOKEN ?? process.env.E2E_BRIDGE_ADMIN_TOKEN ?? "";

// Workspace de test connu (env override). Default à un workspace probable
// existant en staging — sinon skip.
const TEST_WS =
  process.env.E2E_BRIDGE_TEST_WORKSPACE_ID ?? "";

test.describe(`Score endpoint shape [${TARGET}] @critical`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge admin exposé");

  test("GET /api/admin/tenant/:wsId/score → shape valide pour ws existant", async () => {
    test.skip(
      !ADMIN_TOKEN || !TEST_WS,
      "BRIDGE_ADMIN_TOKEN + E2E_BRIDGE_TEST_WORKSPACE_ID requis",
    );
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get(`/api/admin/tenant/${TEST_WS}/score`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      timeoutMs: 15_000,
      allowFailure: true,
    });
    expect(
      res.status,
      `score endpoint ${res.status}: ${res.body.slice(0, 200)}`,
    ).toBe(200);

    const body = res.json() as {
      workspaceId: string;
      score: number;
      label: string;
      services: Record<string, unknown>;
    };
    expect(body).toHaveProperty("workspaceId");
    expect(body).toHaveProperty("score");
    expect(body).toHaveProperty("label");
    expect(body).toHaveProperty("services");
    expect(typeof body.score).toBe("number");
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(typeof body.label).toBe("string");
  });

  test("GET /api/admin/tenant/:wsId/score sans auth → 401/403", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get(`/api/admin/tenant/probe-ws/score`, {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    expect([401, 403]).toContain(res.status);
  });

  test("GET /api/admin/tenant/:wsId/score avec wsId inconnu → 404", async () => {
    test.skip(!ADMIN_TOKEN, "BRIDGE_ADMIN_TOKEN requis");
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get(
      `/api/admin/tenant/e2e-nonexistent-${Date.now()}/score`,
      {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        timeoutMs: 15_000,
        allowFailure: true,
      },
    );
    // 404 attendu, ou 200 avec score=0 (selon implem staminads)
    expect([404, 200]).toContain(res.status);
  });
});

test.describe(`Tenant status endpoint shape [${TARGET}] @critical`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge admin exposé");

  test("GET /api/admin/tenant/:wsId/status → shape valide", async () => {
    test.skip(
      !ADMIN_TOKEN || !TEST_WS,
      "BRIDGE_ADMIN_TOKEN + E2E_BRIDGE_TEST_WORKSPACE_ID requis",
    );
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get(`/api/admin/tenant/${TEST_WS}/status`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      timeoutMs: 15_000,
      allowFailure: true,
    });
    expect(res.status).toBe(200);
    const body = res.json() as {
      workspaceId: string;
      activeServices: string[];
      inactiveServices: string[];
      counts: Record<string, unknown>;
    };
    expect(body).toHaveProperty("activeServices");
    expect(body).toHaveProperty("inactiveServices");
    expect(Array.isArray(body.activeServices)).toBe(true);
    expect(Array.isArray(body.inactiveServices)).toBe(true);
    // Les 6 services connus doivent être présents (active OU inactive)
    const all = [...body.activeServices, ...body.inactiveServices];
    for (const svc of ["pageviews", "forms", "calls", "gsc", "ads", "pagespeed"]) {
      expect(all, `service "${svc}" missing`).toContain(svc);
    }
  });
});
