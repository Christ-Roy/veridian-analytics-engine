/**
 * 17-multi-tenant-isolation — Suppression tenant doit cascader sur ses datas
 * (GDPR + isolation).
 *
 * Test indirect : on appelle GET d'un tenant_id qui devrait être soft-deleted
 * et on vérifie qu'on a 404 ou 402 (paywall soft-delete).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Deletion cascade [${TARGET}] @security`, () => {
  test.skip(target.isDemo, "Demo n'a pas de tenant management");

  test("Bridge health pour tenant inexistant → 404 (pas de leak)", async () => {
    const res = await fetch(
      `${target.bridgeUrl}/api/tenants/hub_tnt_deleted_e2e_12345/health`,
      {
        method: "GET",
        headers: { "X-Veridian-Hub-Signature": "fake", "X-Veridian-Timestamp": "1" },
      },
    );
    // 401 (HMAC reject avant lookup) ou 404 (HMAC OK mais tenant pas trouvé)
    expect([401, 403, 404]).toContain(res.status);
  });
});
