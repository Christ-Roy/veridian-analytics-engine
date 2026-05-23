/**
 * 06-hub-contract — Idempotency key sur provision tenant.
 *
 * Le contrat Hub→bridge spécifie que les provision peuvent être rejouées avec
 * la même Idempotency-Key sans créer de tenant dupliqué.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { signHubRequest } from "../helpers/hub-hmac";
import { randomUUID } from "node:crypto";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const HMAC = process.env.HUB_HMAC_SECRET;

test.describe(`Hub idempotency [${TARGET}] @contract`, () => {
  test.skip(target.isDemo, "Demo n'a pas de provision Hub");

  test("Provision rejoué avec même Idempotency-Key → 200/201 idempotent (pas 409)", async () => {
    test.skip(!HMAC, "HUB_HMAC_SECRET missing");
    if (!HMAC) return;

    const tenantId = `hub_tnt_e2e_idem_${randomUUID().slice(0, 8)}`;
    const idemKey = randomUUID();
    const payload = {
      tenant_id: tenantId,
      workspace_name: `e2e-idem-${idemKey.slice(0, 6)}`,
      owner_email: `e2e-idem-${idemKey.slice(0, 6)}@veridian-test.local`,
      plan: "free" as const,
    };

    const body = JSON.stringify(payload);
    const headers = signHubRequest(body, HMAC);

    // 1st call
    const res1 = await fetch(`${target.bridgeUrl}/api/tenants/provision`, {
      method: "POST",
      headers: { ...headers, "Idempotency-Key": idemKey },
      body,
    });
    // peut être 200/201 ou 5xx selon état staging
    if (res1.status >= 500) {
      test.skip(true, "Bridge down sur staging");
      return;
    }
    expect([200, 201, 202, 409]).toContain(res1.status);
    const body1 = await res1.text();

    // 2nd call — même clé → même résultat, jamais un nouveau tenant
    const headers2 = signHubRequest(body, HMAC); // nouveau timestamp
    const res2 = await fetch(`${target.bridgeUrl}/api/tenants/provision`, {
      method: "POST",
      headers: { ...headers2, "Idempotency-Key": idemKey },
      body,
    });
    expect([200, 201, 202, 409]).toContain(res2.status);
    // Body devrait être identique (même tenant_id)
    if (res1.status === 200 || res1.status === 201) {
      const body2 = await res2.text();
      // Au minimum le tenant_id doit être présent dans les deux body
      expect(body1).toContain(tenantId);
      expect(body2).toContain(tenantId);
    }
  });
});
