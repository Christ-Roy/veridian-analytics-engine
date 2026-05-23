/**
 * 08-voip-calls — VoIP sync + sipcall + calls tab.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`VoIP API endpoints [${TARGET}] @voip`, () => {
  test.skip(target.isDemo, "Demo n'a pas de VoIP réelle");

  test("POST /api/voip/sync sans auth → 401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/voip/sync",
      {},
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([401, 403, 404, 405]).toContain(res.status);
  });

  test("GET /api/voip/calls sans auth → 401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get("/api/voip/calls", {
      allowFailure: true,
      timeoutMs: 10_000,
    });
    expect([401, 403, 404]).toContain(res.status);
  });

  test("POST /api/voip/sipcall sans Bearer → 401/404", async () => {
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.post(
      "/api/voip/sipcall",
      {
        from: "+33987654321",
        to: "+33123456789",
        duration: 42,
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect([401, 403, 404, 405]).toContain(res.status);
  });
});

test.describe(`VoIP calls tab UI [${TARGET}] @voip`, () => {
  test.skip(
    !target.isDemo && !target.isPublic,
    "UI test need accessible target",
  );

  test("/calls tab loads (demo : empty state)", async ({ page }) => {
    const res = await page.goto(`${target.consoleUrl}/calls`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(500);
    const html = await page.content();
    // Pas de stack trace
    expect(html.toLowerCase()).not.toContain("internal server error");
    expect(html.toLowerCase()).not.toContain("at object.");
  });
});
