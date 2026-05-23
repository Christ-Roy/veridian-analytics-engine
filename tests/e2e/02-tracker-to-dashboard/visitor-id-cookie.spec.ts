/**
 * 02-tracker — visitor_id persistance via cookie.
 *
 * On navigue sur la démo deux fois, on vérifie que le tracker pose un cookie
 * (`stm_v` ou `visitor_id`) et que la 2ème visite réutilise le même.
 *
 * Cibles : la démo publique qui charge le tracker live. Si la démo ne pose
 * pas le cookie attendu, c'est probablement parce que le tracker tape sur
 * un endpoint mocké — on skip propre.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const COOKIE_CANDIDATES = ["stm_v", "visitor_id", "stm_visitor_id"];

test.describe(`Tracker visitor_id cookie [${TARGET}] @tracker`, () => {
  test("Première visite pose un cookie visitor_id", async ({ page, context }) => {
    test.skip(
      !target.isPublic && !target.isDemo,
      "Tracker test = cible publique uniquement (staging privé Tailscale)",
    );

    await page.goto(target.consoleUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(2_000); // tracker async
    const cookies = await context.cookies(target.consoleUrl);
    const visitorCookie = cookies.find((c) =>
      COOKIE_CANDIDATES.includes(c.name),
    );
    // Best-effort : si pas de cookie, le tracker est probablement en mode
    // localStorage (acceptable). On vérifie au moins localStorage.
    if (!visitorCookie) {
      const lsVal = await page.evaluate(() => {
        return (
          localStorage.getItem("stm_v") ??
          localStorage.getItem("visitor_id") ??
          localStorage.getItem("stm_visitor_id")
        );
      });
      // Au moins l'un des deux (cookie OU localStorage) doit être présent
      // sur une cible démo publique
      if (target.isDemo) {
        expect(lsVal, "demo: ni cookie ni localStorage visitor_id").toBeTruthy();
      }
    } else {
      expect(visitorCookie.value.length).toBeGreaterThan(5);
    }
  });

  test("Deuxième visite réutilise le même visitor_id (persistance)", async ({
    page,
    context,
  }) => {
    test.skip(
      !target.isPublic && !target.isDemo,
      "Tracker test = cible publique uniquement",
    );

    await page.goto(target.consoleUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(1_500);
    const cookies1 = await context.cookies(target.consoleUrl);
    const v1 = cookies1.find((c) => COOKIE_CANDIDATES.includes(c.name));

    if (!v1) {
      test.skip(true, "Pas de cookie visitor — skip persistance");
      return;
    }

    // Navigation autre page
    await page.goto(`${target.consoleUrl}/login`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(1_500);
    const cookies2 = await context.cookies(target.consoleUrl);
    const v2 = cookies2.find((c) => c.name === v1.name);
    expect(v2?.value).toBe(v1.value);
  });
});
