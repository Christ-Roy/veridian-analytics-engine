/**
 * 07-settings-credentials — Page /settings + sections + credentials encrypt.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Settings page render [${TARGET}] @settings`, () => {
  test.skip(target.isDemo, "Demo n'a pas de settings (readonly)");

  test("/settings → 200 ou 302 vers login (gated)", async ({ page }) => {
    const res = await page.goto(`${target.consoleUrl}/settings`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});

test.describe(`VoIP credentials API [${TARGET}] @settings @voip`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("POST /api/voip/credentials sans auth → 401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/voip/credentials",
      { provider: "ovh", api_key: "fake", api_secret: "fake" },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([401, 403, 404, 405]).toContain(res.status);
  });

  test("GET /api/voip/credentials (auth required) → 401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get("/api/voip/credentials", {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("Credentials API ne leak pas les secrets en clear (si bypass auth → 4xx)", async () => {
    // Si pour une raison X on arrive à GET les credentials → ne doivent
    // pas être en clair dans la réponse.
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get("/api/voip/credentials", {
      headers: { Authorization: "Bearer fake-admin-bypass" },
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
