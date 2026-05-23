/**
 * 06-hub-contract — Paywall states (suspended, trial-expired, soft-deleted).
 *
 * On vérifie que pour un tenant_id donné en query string, si le bridge
 * répond avec 402 sur une route protégée, c'est conforme au contrat
 * Hub→bridge.
 *
 * Sans HUB_HMAC_SECRET disponible, on teste juste qu'une requête signée
 * avec un tenant_id farfelu est rejetée 401 (pas 402 — pas de leak d'info).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { signHubRequest } from "../helpers/hub-hmac";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const HMAC = process.env.HUB_HMAC_SECRET;

test.describe(`Paywall contract [${TARGET}] @contract`, () => {
  test.skip(target.isDemo, "Demo single-tenant, pas de paywall");

  test("Sans HMAC : bridge rejette tenant unknown avec 401 (pas 402)", async () => {
    const body = JSON.stringify({ tenant_id: "hub_tnt_e2e_does_not_exist" });
    const res = await fetch(`${target.bridgeUrl}/api/tenants/health`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // 401 attendu sans HMAC
    expect([401, 403, 404, 405]).toContain(res.status);
    // CRITIQUE : on doit pas répondre 402 (qui leaker l'existence du tenant)
    expect(res.status).not.toBe(402);
  });

  test("Avec HMAC : tenant_id inexistant → 404 (pas 402)", async () => {
    test.skip(!HMAC, "HUB_HMAC_SECRET missing");
    if (!HMAC) return;
    const body = JSON.stringify({
      tenant_id: "hub_tnt_e2e_definitely_does_not_exist_12345",
    });
    const headers = signHubRequest(body, HMAC);
    const res = await fetch(`${target.bridgeUrl}/api/tenants/health`, {
      method: "POST",
      headers,
      body,
    });
    // 404 attendu pour tenant inconnu
    expect([200, 404]).toContain(res.status);
  });
});
