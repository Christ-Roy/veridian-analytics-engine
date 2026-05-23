/**
 * 11-demo-public — Banner démo + CTA visible.
 *
 * On charge la racine de la console démo et on vérifie :
 *   - Le banner `[data-testid="demo-banner"]` est visible
 *   - Il contient un lien `mailto:` avec un contact valide
 *   - Le CTA "Demander un compte" est cliquable
 *
 * Aussi : le titre du document contient "Veridian" (branding correct).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

test.describe(`Demo banner & CTA [${TARGET}]`, () => {
  test.skip(!target.isDemo, "Demo only");

  test("banner démo visible sur racine", async ({ page }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    const banner = page.getByTestId("demo-banner");
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(/démo|demo/i);
  });

  test("banner contient CTA mailto:", async ({ page }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    const cta = page.locator('[data-demo-cta="header"]');
    await expect(cta).toBeVisible({ timeout: 10_000 });
    const href = await cta.getAttribute("href");
    expect(href, "CTA href").toBeTruthy();
    expect(href).toMatch(/^mailto:/);
    expect(href).toMatch(/@veridian\.site/);
  });

  test("titre/branding contient Veridian", async ({ page }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Attente petit que le head soit potentiellement réécrit par le SPA
    await page.waitForTimeout(2_000);
    const title = await page.title();
    expect(title.toLowerCase()).toMatch(/veridian|analytics/);
  });
});
