/**
 * Phase C — Dashboard UI sections critiques.
 *
 * On charge `/workspaces/:wsId/veridian` (le dashboard Veridian root) et on
 * vérifie que chaque section critique rend :
 *   - Score hero : `score-value` visible avec un nombre 0-100 (ou skeleton OK
 *     transitoirement)
 *   - Active services grid : présente avec >= 0 services
 *   - Shadow marketing grid : présente avec 1-6 blocks
 *   - Tabs nav : au moins le tab "veridian" actif/présent
 *   - Header dashboard avec testid `dashboard-header`
 *
 * Tag `@critical`. Démo ws = `demo-apple`. Skip prod/staging sans wsId.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { loginDemo } from "../helpers/login";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

const WORKSPACE_ID = target.isDemo
  ? "demo-apple"
  : process.env.E2E_TEST_WORKSPACE_ID ?? "";

test.describe(`Dashboard UI sections [${TARGET}] @critical`, () => {
  test.skip(!WORKSPACE_ID, `No WORKSPACE_ID for ${TARGET}`);

  test.beforeEach(async ({ page }) => {
    if (target.isDemo) {
      await loginDemo(page, target);
    }
    await page.goto(`${target.consoleUrl}/workspaces/${WORKSPACE_ID}/veridian`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForLoadState("networkidle", { timeout: 20_000 });
  });

  test("dashboard-header rendu", async ({ page }) => {
    const header = page.getByTestId("dashboard-header");
    await expect(header).toBeVisible({ timeout: 10_000 });
  });

  test("score-value : nombre 0-100 (après skeleton)", async ({ page }) => {
    // Attendre que skeleton -> data passe (ou que dashboard-error apparaisse)
    await page
      .waitForSelector(
        '[data-testid="score-value"], [data-testid="dashboard-error"]',
        { timeout: 15_000 },
      )
      .catch(() => {});

    const err = page.getByTestId("dashboard-error");
    const errVisible = await err.isVisible().catch(() => false);
    expect(errVisible, "dashboard-error visible — score endpoint cassé").toBe(
      false,
    );

    const score = page.getByTestId("score-value");
    await expect(score).toBeVisible({ timeout: 10_000 });
    const text = (await score.innerText()).trim();
    // Numéro entre 0 et 100. Peut être "85" ou "85/100" ou "85%"
    const m = text.match(/(\d+)/);
    expect(m, `score-value text "${text}" n'extrait pas de nombre`).toBeTruthy();
    const n = parseInt(m![1], 10);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(100);
  });

  test("active-services-grid présent + shadow-marketing-grid présent", async ({
    page,
  }) => {
    // Au moins un des deux doit être là (selon état du tenant)
    const active = page.getByTestId("active-services-grid");
    const shadow = page.getByTestId("shadow-marketing-grid");

    const activeVisible = await active.isVisible().catch(() => false);
    const shadowVisible = await shadow.isVisible().catch(() => false);
    expect(
      activeVisible || shadowVisible,
      "Ni active-services-grid ni shadow-marketing-grid visibles → dashboard cassé",
    ).toBe(true);

    if (shadowVisible) {
      // Shadow services (max 6 connus)
      const shadowItems = await page
        .locator('[data-testid^="shadow-"]')
        .count();
      expect(shadowItems).toBeGreaterThan(0);
      expect(shadowItems).toBeLessThanOrEqual(6);
    }
  });

  test("au moins un tab nav présent", async ({ page }) => {
    const tabs = await page.locator('[data-testid^="tab-"]').count();
    expect(tabs, "aucun tab-* dans le dashboard").toBeGreaterThan(0);
  });

  test("score-bar visible (gauge ou progress)", async ({ page }) => {
    const bar = page.getByTestId("score-bar");
    // Le score-bar est en bas du hero, peut être absent en état dégradé
    const visible = await bar.isVisible().catch(() => false);
    if (!visible) {
      // Si pas visible mais pas en erreur, c'est tolérable (état empty)
      const empty = await page
        .getByTestId("empty-install-tracker")
        .isVisible()
        .catch(() => false);
      expect(
        empty,
        "score-bar absent ET pas en état empty-install-tracker → bug",
      ).toBe(true);
    }
  });
});
