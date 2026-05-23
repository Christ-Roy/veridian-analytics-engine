/**
 * BUG-12 (P0 UX) — En mode démo, la page `/workspaces/:wsId/account` doit
 * afficher un panneau "Compte non disponible en démo" + CTA mailto, jamais
 * le vrai formulaire d'édition.
 *
 * BUG-21 (P2 UX) — En mode démo, le bouton "Logout" doit être caché /
 * indisponible (un visiteur anonyme n'a pas de session à fermer).
 *
 * Tag `@critical` + `@bug-12 @bug-21`. Démo only.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

const DEMO_WS = "demo-apple";

test.describe(`BUG-12 demo account page gated [${TARGET}] @critical @bug-12`, () => {
  test.skip(!target.isDemo, "Demo only");

  test("`/account` rend le panneau démo (testid account-demo-blocked)", async ({
    page,
  }) => {
    await page.goto(
      `${target.consoleUrl}/workspaces/${DEMO_WS}/account`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    const blocked = page.getByTestId("account-demo-blocked");
    await expect(
      blocked,
      "account-demo-blocked panel doit être visible en démo",
    ).toBeVisible({ timeout: 10_000 });

    // Le CTA mailto présent
    const cta = page.locator('[data-demo-cta="account-page"]');
    await expect(cta).toBeVisible();
    const href = await cta.getAttribute("href");
    expect(href).toMatch(/^mailto:/);
    expect(href).toMatch(/@veridian\.site/);
  });

  test("`/account` NE rend PAS le formulaire d'édition standard", async ({
    page,
  }) => {
    await page.goto(
      `${target.consoleUrl}/workspaces/${DEMO_WS}/account`,
      { waitUntil: "networkidle", timeout: 30_000 },
    );
    // Pas de champ password type=password (signature du formulaire édition)
    // Sauf si caché dans le DOM mais non visible
    const passwordFields = await page
      .locator('input[type="password"]:visible')
      .count();
    expect(
      passwordFields,
      "input[type=password] visible sur /account en démo → form edit accessible",
    ).toBe(0);

    // Bouton "Update password" ou "Change password" ne doit pas être visible
    const updateBtns = await page
      .getByRole("button", { name: /update|change.*password|enregistrer|sauvegarder/i })
      .count();
    expect(
      updateBtns,
      "Update password button visible in demo account page",
    ).toBe(0);
  });
});

test.describe(`BUG-21 demo logout button hidden [${TARGET}] @critical @bug-21`, () => {
  test.skip(!target.isDemo, "Demo only");

  test("aucun lien/button 'Logout' visible côté navigation principale", async ({
    page,
  }) => {
    await page.goto(
      `${target.consoleUrl}/workspaces/${DEMO_WS}`,
      { waitUntil: "networkidle", timeout: 30_000 },
    );

    // Cherche un lien href="/logout" OU un bouton avec texte logout/déconnexion
    // qui soit VISIBLE (pas juste dans le DOM)
    const logoutLink = await page
      .locator('a[href="/logout"], a[href*="logout"]')
      .filter({ has: page.locator(":visible") })
      .count();
    const logoutBtn = await page
      .getByRole("button", { name: /logout|déconnex|sign.?out/i })
      .count();

    const total = logoutLink + logoutBtn;
    expect(
      total,
      `Found ${logoutLink} logout links + ${logoutBtn} logout buttons visible — should be 0 in demo`,
    ).toBe(0);
  });
});
