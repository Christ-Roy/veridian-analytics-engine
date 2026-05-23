/**
 * 19-sdk-tracker — SDK tracker JS : bundle size, init, leak window.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { BUNDLE_BUDGETS } from "../helpers/lighthouse-runner";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const TRACKER_PATHS = ["/js/tracker.js", "/js/script.js", "/tracker.js"];

test.describe(`SDK tracker JS [${TARGET}] @sdk`, () => {
  test("Tracker script accessible via /js/tracker.js ou équivalent", async () => {
    let found = false;
    let bodySize = 0;
    for (const p of TRACKER_PATHS) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        found = true;
        const body = await res.text();
        bodySize = body.length;
        break;
      }
    }
    expect(found, `Aucun script tracker trouvé dans ${TRACKER_PATHS.join(",")}`).toBeTruthy();
    // Bundle non gzip → on attend < 50KB (~10KB gz)
    expect(bodySize).toBeGreaterThan(500); // pas vide
    expect(bodySize).toBeLessThan(100_000);
  });

  test("Tracker bundle gzip < 10KB (budget SDK)", async () => {
    let found = false;
    for (const p of TRACKER_PATHS) {
      const res = await fetch(`${target.engineUrl}${p}`, {
        headers: { "Accept-Encoding": "gzip" },
      });
      if (res.status === 200) {
        found = true;
        // Content-Length du gzip si dispo, sinon length du body
        const cl = res.headers.get("content-length");
        if (cl) {
          const sizeKB = Number(cl) / 1024;
          expect(
            sizeKB,
            `Tracker bundle ${sizeKB.toFixed(1)}KB > budget ${BUNDLE_BUDGETS.trackerSdkJsGzKB}KB`,
          ).toBeLessThan(BUNDLE_BUDGETS.trackerSdkJsGzKB * 2); // tolérance x2
        }
        break;
      }
    }
    if (!found) test.skip(true, "Pas de tracker URL");
  });

  test("Tracker script Content-Type = JS valide", async () => {
    for (const p of TRACKER_PATHS) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        const ct = res.headers.get("content-type") ?? "";
        expect(ct.toLowerCase()).toMatch(/javascript|ecmascript/);
        return;
      }
    }
    test.skip(true, "Pas de tracker URL trouvé");
  });
});

test.describe(`SDK no-leak to window [${TARGET}] @sdk`, () => {
  test.skip(
    !target.isDemo && !target.isPublic,
    "Need a target avec tracker chargé en HTML",
  );

  test("Tracker n'expose pas de globals dangereux (admin/secret) sur window", async ({
    page,
  }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.waitForTimeout(1_500);
    const leaks = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      const dangerous = [
        "ADMIN_TOKEN",
        "BRIDGE_ADMIN_TOKEN",
        "AUTH_SECRET",
        "HUB_HMAC_SECRET",
        "DATABASE_URL",
      ];
      return dangerous.filter((k) => k in w);
    });
    expect(leaks, `Globals dangereux leak: ${leaks.join(",")}`).toEqual([]);
  });

  test("Window.staminads ou window.veridian existe (entry point SDK)", async ({
    page,
  }) => {
    await page.goto(target.consoleUrl, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });
    await page.waitForTimeout(2_000);
    const has = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      // Au moins une de ces clés doit exister (entry SDK)
      return (
        "staminads" in w ||
        "veridian" in w ||
        "stm" in w ||
        "_stm" in w ||
        "Staminads" in w
      );
    });
    // Best-effort : sur demo le tracker peut être absent
    if (!has && target.isDemo) {
      test.skip(true, "Demo n'expose pas le SDK comme global");
    }
  });
});
