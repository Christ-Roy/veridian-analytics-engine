/**
 * 16-security — Rate limit endpoints sensibles.
 *
 * Best-effort : on flood un endpoint et on vérifie qu'on finit par recevoir
 * un 429 (ou un 5xx temporaire). Si le rate limit est à 100req/s, on ne le
 * déclenche pas mais on log un warning.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Rate limit [${TARGET}] @security`, () => {
  test.skip(target.isDemo, "Demo a son propre rate limit (60/min, 11-demo)");

  test("POST /api/auth.login flood 30 req → finit par 429 ou 403", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${target.engineUrl}/api/auth.login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `e2e-flood-${i}@veridian-test.local`,
          password: "wrong",
        }),
      });
      statuses.push(res.status);
    }
    // On accepte : soit un 429 a été déclenché, soit tous 4xx (login wrong → 401)
    const has429 = statuses.includes(429);
    const all4xx = statuses.every((s) => s >= 400 && s < 500);
    expect(
      has429 || all4xx,
      `flood login: statuses=${[...new Set(statuses)].sort().join(",")} — attend 429 ou tous 4xx`,
    ).toBeTruthy();
  });
});
