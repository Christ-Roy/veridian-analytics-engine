/**
 * BUG-01 (P0 sécurité) — `/api/setup.initialize` doit être verrouillé en prod.
 *
 * Trouvé par bug-hunter 2026-05-23 : si l'admin est déjà bootstrap (setupCompleted=true),
 * un appel POST à `setup.initialize` doit renvoyer 4xx (idéalement 400 ou 403).
 * Si jamais ce endpoint répond 200 → catastrophe sécurité (un attacker pourrait
 * créer un admin shadow).
 *
 * Test anti-régression : on POST avec un payload bidon. On EXIGE un 4xx.
 * Tag `@critical` + `@bug-01`.
 *
 * Tourne contre staging + prod + démo (toutes cibles déjà bootstrap).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`BUG-01 setup.initialize locked [${TARGET}] @critical @bug-01`, () => {
  test("GET /api/setup.status → setupCompleted:true (precondition)", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/setup.status", { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    const body = res.json() as { setupCompleted: boolean };
    expect(
      body.setupCompleted,
      `${TARGET}: setupCompleted must be true (admin already bootstrap)`,
    ).toBe(true);
  });

  test("POST /api/setup.initialize → 4xx (jamais 200)", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/setup.initialize",
      {
        email: "e2e-test-attacker@veridian-test.local",
        password: "irrelevant-pw-1234!",
        name: "E2E Attacker",
      },
      { timeoutMs: 10_000, allowFailure: true },
    );

    // CRITICAL : ne JAMAIS retourner 200/201. Si setup déjà fait, doit 4xx.
    expect(
      res.status,
      `setup.initialize returned ${res.status} — should be 4xx (already bootstrap)`,
    ).toBeGreaterThanOrEqual(400);
    expect(res.status, `5xx: ${res.body.slice(0, 200)}`).toBeLessThan(500);

    // Message doit contenir indication "already" / "completed" / "forbidden"
    if (res.status === 400 || res.status === 403 || res.status === 409) {
      const lower = res.body.toLowerCase();
      const hasReason = /already|completed|forbidden|denied|locked|setup/.test(
        lower,
      );
      expect(
        hasReason,
        `setup.initialize 4xx but no clear reason in body: ${res.body.slice(0, 200)}`,
      ).toBe(true);
    }
  });
});
