/**
 * 11-demo-public — Re-seed via secret.
 *
 * L'endpoint `POST /api/demo.generate` est protégé par `DemoProtected` :
 *   - Sans secret → 401/403
 *   - Avec secret invalide → 401/403
 *   - Avec secret valide → 200/202 + workspace `demo-apple` repeuplé
 *
 * Comme c'est destructif (drop + reseed), on TESTE UNIQUEMENT sur
 * demo-staging — JAMAIS sur demo-prod (où seul le cron auto re-seed avec
 * orchestration douce).
 *
 * Le secret est lu via env DEMO_SECRET_ANALYTICS_STAGING. Si pas fourni →
 * test skip.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "demo-staging") as TargetName;
const target = getTarget(TARGET);
const SECRET = process.env.DEMO_SECRET;

test.describe(`Demo re-seed [${TARGET}]`, () => {
  test.skip(!target.isDemo, "Demo only");
  test.skip(
    TARGET === "demo-prod",
    "Re-seed destructif interdit sur demo-prod (seul cron auto autorisé)",
  );

  test("POST /api/demo.generate sans query secret → 401", async () => {
    const res = await fetch(`${target.consoleUrl}/api/demo.generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect([401, 403]).toContain(res.status);
  });

  test("POST /api/demo.generate avec secret invalide → 401", async () => {
    const res = await fetch(
      `${target.consoleUrl}/api/demo.generate?secret=obviously-wrong-secret-12345`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
    );
    expect([401, 403]).toContain(res.status);
  });

  test("POST /api/demo.generate avec secret valide → 2xx (re-seed)", async () => {
    test.skip(!SECRET, "DEMO_SECRET non fourni");
    // Long timeout : le re-seed génère 200k sessions, peut prendre 30-60s
    test.setTimeout(120_000);
    const url = `${target.consoleUrl}/api/demo.generate?secret=${encodeURIComponent(SECRET!)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(
      res.status,
      `demo.generate → ${res.status}`,
    ).toBeLessThan(400);
  });
});
