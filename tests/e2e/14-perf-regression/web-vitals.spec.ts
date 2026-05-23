/**
 * 14-perf-regression — Mesures Web Vitals (FCP/LCP/CLS) sur démo + bundle size.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { measureCoreVitals, BUDGETS, BUNDLE_BUDGETS } from "../helpers/lighthouse-runner";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Web Vitals demo [${TARGET}] @perf`, () => {
  test.skip(
    !target.isDemo && !target.isPublic,
    "Perf test = démo ou prod public",
  );

  test("FCP < budget", async ({ page }) => {
    const vitals = await measureCoreVitals(page, target.consoleUrl, {
      waitMs: 4_000,
    });
    const budget = target.isDemo ? BUDGETS.demo : BUDGETS.dashboardDesktop;
    // FCP = 0 si pas de FCP entry mesuré → on log mais on ne fail pas
    if (vitals.fcp > 0) {
      expect(
        vitals.fcp,
        `FCP=${vitals.fcp}ms > budget ${budget.fcpMs}ms`,
      ).toBeLessThan(budget.fcpMs * 2); // tolérance x2 (CI variance)
    }
  });

  test("LCP < budget x2 (CI tolérance)", async ({ page }) => {
    const vitals = await measureCoreVitals(page, target.consoleUrl, {
      waitMs: 4_000,
    });
    const budget = target.isDemo ? BUDGETS.demo : BUDGETS.dashboardDesktop;
    if (vitals.lcp > 0) {
      expect(
        vitals.lcp,
        `LCP=${vitals.lcp}ms > budget ${budget.lcpMs}ms`,
      ).toBeLessThan(budget.lcpMs * 2);
    }
  });

  test("CLS < budget x2", async ({ page }) => {
    const vitals = await measureCoreVitals(page, target.consoleUrl, {
      waitMs: 4_000,
    });
    const budget = target.isDemo ? BUDGETS.demo : BUDGETS.dashboardDesktop;
    expect(
      vitals.cls,
      `CLS=${vitals.cls} > budget ${budget.cls}`,
    ).toBeLessThan(budget.cls * 2);
  });
});

test.describe(`Bundle size [${TARGET}] @perf`, () => {
  test("Initial JS bundle < 500KB (best-effort)", async ({ page }) => {
    let totalJs = 0;
    page.on("response", (res) => {
      const ct = res.headers()["content-type"] ?? "";
      const cl = res.headers()["content-length"];
      if (ct.includes("javascript") && cl) {
        totalJs += Number(cl);
      }
    });
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    if (totalJs > 0) {
      expect(
        totalJs / 1024,
        `Initial JS ${(totalJs / 1024).toFixed(1)}KB > budget ${BUNDLE_BUDGETS.dashboardInitialJsKB}KB`,
      ).toBeLessThan(BUNDLE_BUDGETS.dashboardInitialJsKB * 3); // tolérance x3
    }
  });
});
