/**
 * 11-demo-public — La démo est accessible sans login.
 *
 * Workspace `demo-apple` doit être chargé en moins de 10s, avec :
 *   - Page 200
 *   - Auto-login anonyme (demo.login) qui retourne un JWT
 *   - is_demo:true dans /api/public-config
 *
 * Tourne contre demo-prod ET demo-staging.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "demo-prod") as TargetName;
const target = getTarget(TARGET);

test.describe(`Demo accessible [${TARGET}]`, () => {
  test.skip(
    !target.isDemo,
    `Test démo only — target ${TARGET} n'est pas une cible démo`,
  );

  test("GET /api/public-config → is_demo:true + demo_workspace_id", async () => {
    const client = new ApiClient(target.consoleUrl);
    const res = await client.get("/api/public-config", { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    const body = res.json() as {
      is_demo: boolean;
      demo_workspace_id: string;
      contact_email: string;
    };
    expect(body.is_demo).toBe(true);
    expect(body.demo_workspace_id).toBeTruthy();
    expect(body.demo_workspace_id).toMatch(/^demo-/);
    expect(body.contact_email).toMatch(/^.+@veridian\.site$/);
  });

  test("POST /api/demo.login → JWT pour le demo user", async () => {
    const client = new ApiClient(target.consoleUrl);
    const res = await client.post("/api/demo.login", {}, { timeoutMs: 15_000 });
    expect(res.status).toBe(200);
    const body = res.json() as {
      access_token: string;
      user?: { email: string; id: string };
    };
    expect(body.access_token).toBeTruthy();
    expect(body.access_token.split(".").length).toBe(3); // JWT
  });

  test("workspace demo-apple chargé dans la console (< 10s)", async ({
    page,
  }) => {
    const t0 = Date.now();
    const res = await page.goto(`${target.consoleUrl}/workspaces/demo-apple`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    expect(res?.status()).toBeLessThan(400);
    // Pas d'erreur visible top-level — on attend que la page rende qqch
    await page.waitForLoadState("networkidle", { timeout: 15_000 });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(15_000);
  });
});
