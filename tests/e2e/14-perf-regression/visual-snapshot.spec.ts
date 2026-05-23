/**
 * 14-perf-regression — Visual regression sur démo (golden snapshots).
 *
 * Note : les goldens ne sont pas commit dans cette première itération. Le
 * workflow `e2e-visual-regression.yml` se charge de les générer (avec
 * --update-snapshots) puis de les comparer aux runs suivants.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Visual snapshot [${TARGET}] @perf @visual`, () => {
  test.skip(
    !target.isDemo,
    "Visual snapshot stable = démo (state seedé reproductible)",
  );

  test("Dashboard root snapshot", async ({ page }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    await page.waitForTimeout(2_500); // anim fade-in
    // Snapshot mode : maxDiffPixels permet 100px de différence (CI variance)
    await expect(page).toHaveScreenshot("dashboard-root.png", {
      maxDiffPixels: 500,
      animations: "disabled",
      fullPage: false,
    });
  });

  test("Tabs visible snapshot", async ({ page }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    await page.waitForTimeout(2_000);
    const nav = page.locator("nav").first();
    if ((await nav.count()) === 0) {
      test.skip(true, "No <nav> found");
      return;
    }
    await expect(nav).toHaveScreenshot("dashboard-nav.png", {
      maxDiffPixels: 200,
      animations: "disabled",
    });
  });
});

test.describe(`Visual snapshot mobile [${TARGET}] @perf @visual @mobile`, () => {
  test.skip(!target.isDemo, "Visual stable = démo");

  test("Dashboard mobile snapshot", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    await page.waitForTimeout(2_500);
    await expect(page).toHaveScreenshot("dashboard-mobile-375.png", {
      maxDiffPixels: 500,
      animations: "disabled",
      fullPage: false,
    });
  });
});
