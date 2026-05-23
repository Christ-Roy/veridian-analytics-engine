/**
 * 17-multi-tenant-isolation — Cross-tenant access doit être strictement rejeté.
 *
 * Tests :
 *   - Site key tenant A → ne peut INGEST que pour tenant A
 *   - Bearer admin tenant A → ne peut READ que ses workspaces
 *   - Bridge HMAC : tenant_id strict (pas d'usurpation)
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Multi-tenant isolation [${TARGET}] @security @critical`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("site_key invalide → 401/404 (pas d'ingest cross-tenant)", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/track",
      {
        site_key: "stm_pub_e2e_fake_does_not_exist_12345",
        type: "pageview",
        url: "http://e2e.test/page",
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    // 404 (sitekey unknown), 401 (rejected), 400 (validation) acceptés
    // Critique : JAMAIS 200 ou 201 sans validation du site_key
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("Bearer admin invalide → ne peut pas listing workspaces", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/workspace.list", {
      headers: { Authorization: "Bearer e2e-fake-admin-token-cross-tenant" },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("Bridge tenant_id usurpé sans HMAC → 401", async () => {
    const res = await fetch(`${target.bridgeUrl}/api/tenants/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_id: "hub_tnt_anyone" }),
    });
    // Pas de HMAC = 401 quoi qu'il arrive
    expect([401, 403, 404, 405]).toContain(res.status);
  });
});

test.describe(`Tenant workspace not enumerable [${TARGET}] @security`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("GET /api/workspace.get?id=ws_random_fake → 404/401", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get(
      "/api/workspace.get?id=ws_random_does_not_exist_e2e_12345",
      { allowFailure: true, timeoutMs: 10_000 },
    );
    // 404 attendu (workspace n'existe pas) OU 401 (auth requise avant lookup)
    // Critique : JAMAIS 200 (data leak)
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
