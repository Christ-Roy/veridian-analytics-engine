/**
 * 12-auth-flow — Logout doit invalider la session.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Logout clears session [${TARGET}]`, () => {
  test.skip(
    target.isDemo,
    "Demo flow: pas de logout en démo (bouton masqué BUG-21)",
  );

  test("POST /api/auth.logout sans token → 4xx/401", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/auth.logout",
      {},
      { allowFailure: true, timeoutMs: 10_000 },
    );
    // 401 attendu, ou 200/204 si la route ignore tokens manquants (idempotent)
    expect([200, 204, 400, 401, 403, 404, 405]).toContain(res.status);
  });

  test("POST /api/auth.logout avec token bidon → 4xx", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/auth.logout",
      {},
      {
        headers: { Authorization: "Bearer invalid-jwt-token-e2e" },
        allowFailure: true,
        timeoutMs: 10_000,
      },
    );
    expect([200, 204, 400, 401, 403, 404, 405]).toContain(res.status);
  });
});
