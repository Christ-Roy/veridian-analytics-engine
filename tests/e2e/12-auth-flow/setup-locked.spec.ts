/**
 * 12-auth-flow — Anti-régression BUG-01 (déjà testé en 02-bugs-regression/,
 * dupliqué ici dans le dossier auth pour visibilité dans la suite auth).
 *
 * Le endpoint /api/setup.initialize doit être verrouillé après le bootstrap.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Setup locked [${TARGET}] @critical @bug-01`, () => {
  test("setup.status → setupCompleted:true", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/setup.status", { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    const body = res.json() as { setupCompleted: boolean };
    expect(body.setupCompleted).toBe(true);
  });

  test("setup.initialize after bootstrap → 4xx", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/setup.initialize",
      {
        email: "e2e-test-attacker-12@veridian-test.local",
        password: "irrelevant-pw-1234!",
        name: "E2E Attacker 12",
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
