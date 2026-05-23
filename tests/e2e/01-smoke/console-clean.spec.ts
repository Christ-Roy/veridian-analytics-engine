/**
 * 01-smoke — Console JS clean au load.
 *
 * Ouvre la racine de la console dans un navigateur réel (chromium). On
 * vérifie que :
 *   - Pas d'erreur console (level=error) au chargement (5s grace period)
 *   - Pas de requête réseau qui finit en 5xx
 *
 * Tolérance : on accepte les WARN et les 4xx (login, public-config 404 sur
 * staging). On bloque sur les ERR et les 5xx.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Console clean at load [${TARGET}]`, () => {
  test("racine console : pas d'erreur JS console + pas de 5xx réseau", async ({
    page,
  }) => {
    const errors: string[] = [];
    const networkErrors: Array<{ url: string; status: number }> = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        // Filter out some known noisy errors not under our control
        const text = msg.text();
        // Skip CORS errors from third-party scripts (rare but possible)
        if (/CORS|cross-origin/i.test(text)) return;
        // Skip favicon 404 (négligeable)
        if (/favicon/i.test(text)) return;
        errors.push(text);
      }
    });

    page.on("pageerror", (err) => {
      errors.push(`pageerror: ${err.message}`);
    });

    page.on("response", (resp) => {
      if (resp.status() >= 500) {
        networkErrors.push({ url: resp.url(), status: resp.status() });
      }
    });

    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    // Petite grace period pour que les XHR async finissent
    await page.waitForTimeout(2_000);

    expect(
      errors,
      `Console errors: ${errors.map((e) => "\n  - " + e).join("")}`,
    ).toEqual([]);
    expect(
      networkErrors,
      `5xx network: ${JSON.stringify(networkErrors)}`,
    ).toEqual([]);
  });
});
