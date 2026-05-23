/**
 * 11-demo-public — Les sous-pages workspace de la démo ne rendent jamais
 * blanc.
 *
 * Régression BUG-03 (2026-05-23) : la page `/goals` du demo-apple crashait
 * silencieusement sur `t.toFixed is not a function` (ClickHouse renvoie les
 * agrégats en string, `row.goals as number` était une assertion TS sans
 * coerce runtime). L'errorComponent du root rendait une page minuscule
 * (~120 chars) — pas un vrai blank, mais visuellement équivalent.
 *
 * Ce test vérifie que chaque sous-page workspace majeure rend AU MOINS un
 * heading (`h1`/`h2`/`h3`) — garde-fou simple et robuste contre tous les
 * cas où un crash de rendu côté console viderait la page.
 *
 * Tourne contre demo-prod ET demo-staging (gated sur target.isDemo).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

const SUBPAGES = [
  { path: "", label: "dashboard" },
  { path: "/explore", label: "explore" },
  { path: "/goals", label: "goals" },
  { path: "/filters", label: "filters" },
  { path: "/annotations", label: "annotations" },
  { path: "/settings", label: "settings" },
] as const;

test.describe(`Demo workspace pages not blank [${TARGET}]`, () => {
  test.skip(
    !target.isDemo,
    `Test démo only — target ${TARGET} n'est pas une cible démo`,
  );

  for (const { path, label } of SUBPAGES) {
    test(`/workspaces/demo-apple${path || ""} rend au moins un heading`, async ({
      page,
    }) => {
      const res = await page.goto(
        `${target.consoleUrl}/workspaces/demo-apple${path}`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      );
      expect(res?.status()).toBeLessThan(400);
      await page.waitForLoadState("networkidle", { timeout: 15_000 });

      // Garde-fou anti-blank : au moins 1 heading visible. Si le composant
      // crash, l'errorComponent affiche un Result Ant Design qui n'a pas
      // de h1/h2/h3 — donc count === 0 = crash silencieux détecté.
      const headingCount = await page.locator("h1, h2, h3").count();
      expect(headingCount, `Page ${label} should render at least one heading`).toBeGreaterThan(0);
    });
  }
});
