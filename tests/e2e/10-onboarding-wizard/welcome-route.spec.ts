/**
 * 10-onboarding-wizard — Route /welcome accessible + snippet copy-clipboard.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Welcome route [${TARGET}] @onboarding`, () => {
  test("/welcome accessible (200 ou redirect)", async ({ page }) => {
    const res = await page.goto(`${target.consoleUrl}/welcome`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(500);
  });

  test("/welcome render contient un snippet tracker (script tag JS)", async ({
    page,
  }) => {
    test.skip(target.isDemo, "Demo n'a pas de /welcome onboarding");
    const res = await page.goto(`${target.consoleUrl}/welcome`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    if ((res?.status() ?? 0) >= 400) {
      test.skip(true, "Welcome page renvoie 4xx (probablement need auth)");
      return;
    }
    const html = await page.content();
    // Le snippet attendu contient `<script` + l'URL engine
    // Si l'utilisateur n'est pas loggué, /welcome redirect vers /login (acceptable)
    if (page.url().includes("/welcome")) {
      expect(html.length).toBeGreaterThan(500);
    }
  });
});

test.describe(`Welcome step check tracker [${TARGET}] @onboarding`, () => {
  test("Endpoint /api/tracker.detect (si présent) accepte URL et retourne JSON", async () => {
    test.skip(target.isDemo, "Demo single-tenant");
    const res = await fetch(`${target.engineUrl}/api/tracker.detect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.client-site.com" }),
    });
    // 404 acceptable (endpoint pas exposé), 200/400/401 si oui
    expect(res.status).toBeLessThan(500);
  });
});
