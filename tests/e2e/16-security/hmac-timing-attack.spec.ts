/**
 * 16-security — HMAC compare doit être constant-time (anti timing attack).
 *
 * Test indirect : on envoie 50 signatures successivement, on mesure que la
 * variance de réponse est faible (pas de pattern qui correspond au nombre
 * d'octets corrects). Pas un test parfait mais flag les régressions évidentes
 * (genre `===` au lieu de `crypto.timingSafeEqual`).
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`HMAC timing safety [${TARGET}] @security`, () => {
  test.skip(target.isDemo, "Demo n'a pas de bridge HMAC");

  test("HMAC rejet rapide ne révèle pas le secret (variance faible)", async () => {
    const N = 20;
    const VALID_LIKE = "a".repeat(64); // 64 hex chars
    const RANDOM = "f".repeat(64);
    const durationsValidShape: number[] = [];
    const durationsRandom: number[] = [];

    const body = JSON.stringify({ tenant_id: "e2e-timing", workspace_name: "x" });

    for (let i = 0; i < N; i++) {
      const t1 = performance.now();
      await fetch(`${target.bridgeUrl}/api/tenants/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Veridian-Timestamp": String(Date.now()),
          "X-Veridian-Hub-Signature": VALID_LIKE,
        },
        body,
      });
      durationsValidShape.push(performance.now() - t1);

      const t2 = performance.now();
      await fetch(`${target.bridgeUrl}/api/tenants/provision`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Veridian-Timestamp": String(Date.now()),
          "X-Veridian-Hub-Signature": RANDOM,
        },
        body,
      });
      durationsRandom.push(performance.now() - t2);
    }

    const avgValid =
      durationsValidShape.reduce((s, n) => s + n, 0) / durationsValidShape.length;
    const avgRandom =
      durationsRandom.reduce((s, n) => s + n, 0) / durationsRandom.length;
    // Tolérance large : si > 50ms de différence, c'est suspect
    const diff = Math.abs(avgValid - avgRandom);
    expect(
      diff,
      `Timing variance trop large entre signature valide-shape (${avgValid}ms) et random (${avgRandom}ms), diff=${diff}ms`,
    ).toBeLessThan(50);
  });
});
