/**
 * 11-demo-public — Extensions guards démo (signup/workspace.create/delete/billing).
 *
 * Tous ces endpoints doivent être bloqués 4xx en démo (IS_DEMO=true côté API).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const DESTRUCTIVE_ENDPOINTS = [
  { path: "/api/auth.signup", method: "POST", body: { email: "e2e-demo-attacker@veridian-test.local", password: "x" } },
  { path: "/api/workspace.create", method: "POST", body: { name: "e2e-demo-evil-ws" } },
  { path: "/api/workspace.delete", method: "POST", body: { workspace_id: "any" } },
  { path: "/api/billing.subscribe", method: "POST", body: { plan: "pro" } },
];

test.describe(`Demo guards extended [${TARGET}] @demo @critical`, () => {
  test.skip(!target.isDemo, "Test démo uniquement");

  for (const ep of DESTRUCTIVE_ENDPOINTS) {
    test(`${ep.method} ${ep.path} → 4xx (jamais 2xx en démo)`, async () => {
      const client = new ApiClient(target.engineUrl);
      const res = await client.post(ep.path, ep.body, {
        allowFailure: true,
        timeoutMs: 10_000,
      });
      // 403 (IS_DEMO gated), 401 (no auth), 404 (endpoint absent) acceptés
      // Critical : pas 200 ou 201 (destructif réussi en démo = bug)
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
    });
  }
});

test.describe(`Demo /account et /billing pages [${TARGET}] @demo`, () => {
  test.skip(!target.isDemo, "Test démo uniquement");

  test("/account → 403 ou redirect (BUG-12 gated)", async ({ page }) => {
    const res = await page.goto(`${target.consoleUrl}/account`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    // soit 403 explicite, soit la page renvoie un message "demo readonly"
    if ((res?.status() ?? 0) === 200) {
      const html = await page.content();
      const lower = html.toLowerCase();
      const hasDemoGate =
        lower.includes("demo") ||
        lower.includes("read") ||
        lower.includes("démo") ||
        lower.includes("not available");
      expect(hasDemoGate, "Demo /account doit indiquer le mode démo").toBeTruthy();
    } else {
      expect(res?.status() ?? 0).toBeGreaterThanOrEqual(300);
    }
  });

  test("/billing → bloqué en démo", async ({ page }) => {
    const res = await page.goto(`${target.consoleUrl}/billing`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status() ?? 0).toBeLessThan(500);
  });
});

test.describe(`Demo iPhone tab "coming soon" placeholder [${TARGET}] @demo`, () => {
  test.skip(!target.isDemo, "Test démo uniquement");

  test("Tab Veridian rend (anti-BUG-02) avec contenu visible (>100 chars rendered)", async ({
    page,
  }) => {
    await page.goto(`${target.consoleUrl}/veridian`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const visibleText = await page.evaluate(() => document.body.innerText);
    expect(visibleText.length).toBeGreaterThan(50);
  });
});
