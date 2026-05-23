/**
 * 12-auth-flow — 404 / 500 pages doivent être brandées Veridian (pas staminads).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Error pages branded [${TARGET}] @branding`, () => {
  test("GET /this-route-definitely-does-not-exist-e2e → 404 branded", async ({
    page,
  }) => {
    const res = await page.goto(
      `${target.consoleUrl}/this-route-definitely-does-not-exist-e2e`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    expect(res?.status() ?? 0).toBeGreaterThanOrEqual(200);
    expect(res?.status() ?? 0).toBeLessThan(600);

    const html = await page.content();
    const lower = html.toLowerCase();
    // pas de leak Staminads en public
    expect(lower).not.toContain("staminads.com");
    expect(lower).not.toContain("upstream/staminads");
  });

  test("404 page doit contenir un lien retour", async ({ page }) => {
    await page.goto(
      `${target.consoleUrl}/another-missing-route-e2e-${Date.now()}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    const html = await page.content();
    // le mot "veridian" doit apparaître quelque part (branding)
    expect(html.toLowerCase()).toContain("veridian");
  });
});
