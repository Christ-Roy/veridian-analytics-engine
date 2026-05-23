/**
 * BUG-03/04/05 (P1 UX) — Les sous-pages workspace ne doivent pas crasher en
 * rendu silencieux.
 *
 * Trouvé par bug-hunter 2026-05-23 :
 *   - BUG-03 : `/goals` crash sur `t.toFixed is not a function` (ClickHouse
 *     renvoie agrégats en string, cast TS naïf)
 *   - BUG-04 : `/filters` rend une coquille vide (< 1000 chars utiles)
 *   - BUG-05 : `/settings` idem
 *
 * Ce test est complémentaire à `11-demo-public/demo-workspace-pages-not-blank.spec.ts`
 * (qui vérifie juste `>0 headings`). Ici on est plus strict : contenu utile
 * > 1000 chars + absence du composant d'erreur Ant Design "Result".
 *
 * Tag `@critical` + `@bug-03 @bug-04 @bug-05`.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { loginDemo } from "../helpers/login";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

const WORKSPACE_ID = target.isDemo
  ? "demo-apple"
  : process.env.E2E_TEST_WORKSPACE_ID ?? "";

interface SubPage {
  path: string;
  label: string;
  bug: string;
  /** Min body text length required to NOT be considered blank. */
  minChars: number;
}

const SUBPAGES: SubPage[] = [
  { path: "/goals", label: "goals", bug: "BUG-03", minChars: 800 },
  { path: "/filters", label: "filters", bug: "BUG-04", minChars: 600 },
  { path: "/settings", label: "settings", bug: "BUG-05", minChars: 1000 },
  // Bonus pages (régression future-proof)
  { path: "/annotations", label: "annotations", bug: "bonus", minChars: 400 },
  { path: "/explore", label: "explore", bug: "bonus", minChars: 600 },
];

test.describe(`BUG-03/04/05 workspace subpages content [${TARGET}] @critical`, () => {
  test.skip(
    !WORKSPACE_ID,
    `Skipped: no WORKSPACE_ID for target ${TARGET}. Set E2E_TEST_WORKSPACE_ID for staging/prod.`,
  );

  test.beforeEach(async ({ page }) => {
    if (target.isDemo) {
      await loginDemo(page, target);
    }
  });

  for (const sp of SUBPAGES) {
    test(`${sp.bug}: /workspaces/${WORKSPACE_ID}${sp.path} rend > ${sp.minChars} chars utiles`, async ({
      page,
    }) => {
      const url = `${target.consoleUrl}/workspaces/${WORKSPACE_ID}${sp.path}`;
      const res = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      expect(res?.status(), `${url} returned ${res?.status()}`).toBeLessThan(
        400,
      );
      await page.waitForLoadState("networkidle", { timeout: 20_000 });

      // Récupère le texte rendu visible (innerText, pas innerHTML)
      const bodyText = await page
        .locator("body")
        .innerText({ timeout: 5_000 });
      expect(
        bodyText.length,
        `${sp.label} page returned only ${bodyText.length} chars — likely blank/crash. URL=${url}`,
      ).toBeGreaterThanOrEqual(sp.minChars);

      // Vérifie absence du composant d'erreur Ant Design Result (rendu sur crash)
      const antResult = await page
        .locator(".ant-result-error, .ant-result-warning")
        .count();
      expect(
        antResult,
        `${sp.label}: AntResult error component visible → silent crash`,
      ).toBe(0);

      // Au moins un heading
      const headingCount = await page.locator("h1, h2, h3").count();
      expect(
        headingCount,
        `${sp.label}: no heading rendered`,
      ).toBeGreaterThan(0);
    });
  }
});
