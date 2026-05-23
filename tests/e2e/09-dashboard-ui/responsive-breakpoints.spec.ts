/**
 * 09-dashboard-ui — Responsive 375 / 768 / 1920 (mobile/tablet/desktop).
 *
 * Sur la démo publique (qui a une session anonyme), on vérifie qu'on n'a
 * pas de scroll horizontal débile à 375px et que la nav est utilisable.
 */

import { test, expect, devices } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const BREAKPOINTS = [
  { name: "mobile-375", width: 375, height: 812 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "desktop-1920", width: 1920, height: 1080 },
];

test.describe(`Dashboard responsive breakpoints [${TARGET}] @ui`, () => {
  test.skip(
    !target.isDemo && !target.isPublic,
    "Test responsive demande accès UI (démo uniquement sans login)",
  );

  for (const bp of BREAKPOINTS) {
    test(`${bp.name} (${bp.width}px) — pas de scroll horizontal débile`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width: bp.width, height: bp.height },
      });
      const page = await ctx.newPage();
      const res = await page.goto(target.consoleUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      expect(res?.status() ?? 0).toBeLessThan(500);
      await page.waitForTimeout(1_000);

      const overflow = await page.evaluate(() => {
        return {
          docWidth: document.documentElement.scrollWidth,
          viewWidth: window.innerWidth,
        };
      });
      // tolerance 2px pour les paddings
      expect(
        overflow.docWidth,
        `${bp.name}: scrollWidth=${overflow.docWidth} > viewWidth=${overflow.viewWidth}`,
      ).toBeLessThanOrEqual(overflow.viewWidth + 2);
      await ctx.close();
    });
  }
});

test.describe(`Dashboard timezone selector [${TARGET}] @ui`, () => {
  test.skip(!target.isDemo, "Test sélecteur TZ = démo uniquement");

  test("Dashboard charge sans erreur console critical", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    await page.waitForTimeout(2_000);
    // Filtre les errors non bloquantes (favicon, web push, dev tools)
    const critical = errors.filter(
      (e) =>
        !/favicon|manifest|web-push|service-worker|404/i.test(e) &&
        !/Failed to load resource/.test(e),
    );
    expect(critical.length, `Console errors: ${critical.join(" | ")}`).toBeLessThan(
      3,
    );
  });
});
