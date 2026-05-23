/**
 * BUG-13 (P3 branding) — La version affichée dans la console ne doit pas être
 * la version upstream Staminads (v6.1.0). Si elle est exposée, ce doit être
 * une version Veridian (préfixée "veridian-" ou suivant un schéma propre).
 *
 * Stratégie : on cherche dans le DOM toute chaîne `vX.Y.Z`. Si on en trouve une,
 * elle ne doit pas être "v6.1.0" (ou tout autre version Staminads connue) sur
 * un build Veridian. C'est un test best-effort — si pas de version exposée → OK.
 *
 * Tag `@bug-13`. Public targets only.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

// Versions upstream Staminads connues à blacklister
const UPSTREAM_VERSIONS = [
  /\bv?6\.1\.0\b/,
  /\bstaminads.*v?\d+\.\d+\.\d+/i,
];

test.describe(`BUG-13 version not upstream [${TARGET}] @bug-13`, () => {
  test.skip(
    !(target.isPublic || target.isDemo),
    "Internal staging may show upstream version",
  );

  test("aucune mention de version upstream Staminads dans le DOM", async ({
    page,
  }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.waitForTimeout(2_000);

    const html = await page.content();
    for (const re of UPSTREAM_VERSIONS) {
      const match = html.match(re);
      expect(
        match,
        `Found upstream version "${match?.[0]}" in DOM — should be Veridian-branded`,
      ).toBeNull();
    }
  });
});
