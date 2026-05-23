/**
 * 13-cross-app-inbound — Le bridge accepte des requêtes Hub réelles depuis
 * Hub.staging.veridian.site (cf [[reference_hub_bridge_contract]]).
 *
 * Sans HUB_HMAC_SECRET, on vérifie juste que les endpoints existent et
 * rejettent les requêtes non signées.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { signHubRequest } from "../helpers/hub-hmac";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const HMAC = process.env.HUB_HMAC_SECRET;

const ENDPOINTS = [
  "/api/tenants/provision",
  "/api/tenants/attach-owner",
  "/api/tenants/health",
  "/api/tenants/suspend",
  "/api/tenants/resume",
  "/api/tenants/soft-delete",
];

test.describe(`Hub→bridge endpoints [${TARGET}] @contract`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge HMAC");

  for (const path of ENDPOINTS) {
    test(`${path} sans HMAC → 401/404`, async () => {
      const res = await fetch(`${target.bridgeUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tenant_id: "hub_tnt_e2e_unsigned" }),
      });
      expect([401, 403, 404, 405]).toContain(res.status);
    });
  }

  test("HMAC valide health roundtrip pour tenant unknown → 404 (pas 5xx)", async () => {
    test.skip(!HMAC, "HUB_HMAC_SECRET missing");
    if (!HMAC) return;
    const body = JSON.stringify({ tenant_id: "hub_tnt_e2e_roundtrip_test" });
    const headers = signHubRequest(body, HMAC);
    const res = await fetch(`${target.bridgeUrl}/api/tenants/health`, {
      method: "POST",
      headers,
      body,
    });
    expect(res.status).toBeLessThan(500);
  });
});

test.describe(`Bridge→staminads forward (form/call) [${TARGET}] @contract`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge");

  test("POST /api/ingest/form propagation acceptée par staminads (best-effort)", async () => {
    // Le bridge doit forward au staminads engine sans intermédiaire visible
    const res = await fetch(`${target.bridgeUrl}/api/ingest/form`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        siteKey: "stm_pub_e2e_propagation_test",
        formSlug: "e2e-propagation",
        data: { email: "e2e@veridian-test.local" },
      }),
    });
    // sitekey unknown → 404 attendu, mais pas 5xx
    expect(res.status).toBeLessThan(500);
  });
});
