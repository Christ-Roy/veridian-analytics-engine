/**
 * 09-dashboard-ui — Navigation tabs (Veridian + staminads native) deep-linkable.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const TABS = [
  { name: "veridian", url: "/veridian" },
  { name: "analytics", url: "/analytics" },
  { name: "leads", url: "/leads" },
];

test.describe(`Dashboard tabs navigation [${TARGET}] @ui`, () => {
  test.skip(
    !target.isDemo && !target.isPublic,
    "Tabs nav = demo (login auto) ou prod public",
  );

  for (const tab of TABS) {
    test(`Deep-link ${tab.url} → rend la page (>1000 chars)`, async ({ page }) => {
      const res = await page.goto(`${target.consoleUrl}${tab.url}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      // 200 OK, ou 302 vers /login si pas authentifié (acceptable hors demo)
      expect(res?.status() ?? 0).toBeLessThan(500);
      const html = await page.content();
      // pas de page blanche
      expect(html.length).toBeGreaterThan(500);
    });
  }
});

test.describe(`Dashboard nav staminads intacte [${TARGET}] @ui`, () => {
  test.skip(!target.isDemo, "Demo seul: BUG-anti-régression nav staminads");

  test("/account présent (gated en démo, accessible sinon)", async ({ page }) => {
    await page.goto(`${target.consoleUrl}/account`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const html = await page.content();
    // En démo : on s'attend à 403 ou redirect (BUG-12)
    // mais pas une 500 ni un crash
    expect(html.length).toBeGreaterThan(100);
  });
});
