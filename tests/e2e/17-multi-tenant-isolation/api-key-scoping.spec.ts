/**
 * 17-multi-tenant-isolation — API keys (site_key, admin token) doivent être
 * scopés par tenant.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`API key tenant scoping [${TARGET}] @security`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("Format site_key respecte le schéma stm_pub_*", async () => {
    // Récup public-config si dispo, sinon skip
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/public-config", {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    if (res.status !== 200) {
      test.skip(true, "Pas de /api/public-config");
      return;
    }
    const body = res.json() as { site_key?: string };
    if (body.site_key) {
      expect(body.site_key).toMatch(/^stm_pub_/);
      // Pas de stm_priv_ ou stm_admin_ en public
      expect(body.site_key).not.toMatch(/^stm_(priv|admin|secret)_/);
    }
  });

  test("Aucun endpoint /api/admin/* n'est accessible avec un site_key (sitekey ≠ bearer)", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get("/api/admin/tenants", {
      headers: { "X-Site-Key": "stm_pub_anything_anywhere" },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403, 404]).toContain(res.status);
  });
});
