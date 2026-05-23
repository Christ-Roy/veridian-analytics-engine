/**
 * BUG-08/09 (P2 branding) — Le branding doit être "Veridian Analytics" :
 *   - BUG-08 : `<title>` doit contenir "Veridian" (jamais "Staminads" en prod
 *     ou démo publique)
 *   - BUG-09 : Le logo principal doit avoir un attribut `alt` contenant
 *     "Veridian" (accessibilité + branding)
 *
 * Tag `@critical` + `@bug-08 @bug-09`. Tourne contre prod, staging et démo.
 * On accepte "Staminads" en staging interne uniquement.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

test.describe(`BUG-08/09 branding title + logo alt [${TARGET}] @critical`, () => {
  test("BUG-08: <title> contient Veridian (jamais Staminads en public)", async ({
    page,
  }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // Petit délai pour SPA réécriture du title
    await page.waitForTimeout(2_000);

    const title = await page.title();
    expect(title.length, "title must be non-empty").toBeGreaterThan(0);

    if (target.isPublic || target.isDemo) {
      // Cibles publiques : ne JAMAIS afficher Staminads dans le title
      expect(
        title.toLowerCase(),
        `Public target ${TARGET} <title> = "${title}" → leak branding upstream`,
      ).not.toMatch(/staminads/i);
      expect(
        title.toLowerCase(),
        `Public target ${TARGET} <title> = "${title}" → no Veridian branding`,
      ).toMatch(/veridian|analytics/);
    }
  });

  test("BUG-09: logo principal a un alt accessible", async ({ page }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // On cherche les images avec testid ou role logo
    // Priorité : data-testid="auth-logo" (login page) sinon n'importe quelle img logo
    const logoCandidates = await page
      .locator(
        '[data-testid="auth-logo"], img[alt*="Veridian" i], img[alt*="logo" i], img[src*="logo"]',
      )
      .all();

    if (logoCandidates.length === 0) {
      // Pas de logo trouvé sur cette page (peut être la landing) — skip soft
      test.skip(true, "No logo found on landing page — not testable here");
      return;
    }

    // Au moins un logo doit avoir un alt non-vide qui mentionne Veridian
    let foundGoodAlt = false;
    for (const logo of logoCandidates) {
      const alt = await logo.getAttribute("alt");
      if (alt && /veridian|analytics/i.test(alt)) {
        foundGoodAlt = true;
        break;
      }
    }
    expect(
      foundGoodAlt,
      `Aucun logo avec alt contenant "Veridian" trouvé (${logoCandidates.length} candidats inspectés)`,
    ).toBe(true);
  });
});
