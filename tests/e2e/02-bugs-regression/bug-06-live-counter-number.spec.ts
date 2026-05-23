/**
 * BUG-06 (P1 UX) — Le compteur "X live now" doit afficher un nombre normal.
 *
 * Trouvé par bug-hunter 2026-05-23 : ClickHouse renvoyait `sessions` en string
 * (sérialization UInt64), reduce concaténait au lieu d'additionner → garbage
 * "099644222211 live now". Fix : `Number(d.sessions || 0)` dans le reduce.
 *
 * Test anti-régression : le texte du counter doit matcher `/^\d{1,5} live now$/`.
 * Tout texte > 5 chiffres = bug ré-introduit.
 *
 * Tag `@critical` + `@bug-06`. Tourne contre démo (workspace `demo-apple`).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

const WORKSPACE_ID = target.isDemo
  ? "demo-apple"
  : process.env.E2E_TEST_WORKSPACE_ID ?? "";

test.describe(`BUG-06 live counter is normal number [${TARGET}] @critical @bug-06`, () => {
  test.skip(
    !WORKSPACE_ID,
    `Skipped: no WORKSPACE_ID for target ${TARGET}.`,
  );

  test("'/live' affiche un compteur de visiteurs normal (1-5 chiffres)", async ({
    page,
  }) => {
    await page.goto(
      `${target.consoleUrl}/workspaces/${WORKSPACE_ID}/live`,
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    await page.waitForLoadState("networkidle", { timeout: 15_000 });

    // Le texte est "<N> live now". On le matche via locator text.
    const counter = page.getByText(/^\s*\d+\s+live now\s*$/);
    await expect(counter, "compteur 'X live now' visible").toBeVisible({
      timeout: 10_000,
    });

    const text = (await counter.innerText()).trim();
    const match = text.match(/^(\d+)\s+live now$/);
    expect(match, `live counter text = "${text}" — should match /\\d+ live now/`).toBeTruthy();
    const n = parseInt(match![1], 10);
    expect(
      n,
      `live counter = ${n} — should be < 100000 (got garbage if huge, BUG-06 reintroduced)`,
    ).toBeLessThan(100_000);
  });
});
