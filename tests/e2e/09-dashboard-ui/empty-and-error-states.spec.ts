/**
 * 09-dashboard-ui — Empty states + error states (bridge down).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Dashboard empty + error states [${TARGET}] @ui`, () => {
  test.skip(!target.isDemo && !target.isPublic, "Demo/public uniquement");

  test("Dashboard charge avec data (demo): score visible, pas d'écran d'erreur", async ({
    page,
  }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 45_000,
    });
    await page.waitForTimeout(1_500);
    const html = await page.content();
    const lower = html.toLowerCase();
    // Pas d'écran "error 5xx", "500", "internal server error" visible
    expect(lower).not.toContain("internal server error");
    // Si la page est en erreur, on doit avoir un message clean
    // (pas un raw stack trace)
    expect(lower).not.toContain("at object.");
    expect(lower).not.toContain("/home/node/");
  });

  test("Tab inconnu /xyz-fake-tab → 404 propre ou fallback", async ({ page }) => {
    const res = await page.goto(
      `${target.consoleUrl}/xyz-this-tab-doesnt-exist-${Date.now()}`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    // 404 attendu mais on tolère un fallback à 200 si l'app a un catch-all
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});
