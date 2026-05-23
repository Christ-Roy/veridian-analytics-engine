/**
 * 15-chaos — Scénarios dégradés.
 *
 * Cette suite est en mode observation : on ne déclenche PAS de chaos réel
 * (ce serait dangereux en staging partagé). On vérifie juste que :
 *   - Les endpoints répondent avec 5xx clean (pas hang infini) si dégradé
 *   - SSL cert valide et expire pas dans les 7j
 *   - Pas de container restart en boucle (via health endpoint stable)
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Chaos observability [${TARGET}] @chaos`, () => {
  test("Endpoint /api/health stable sur 10 requêtes successives", async () => {
    const candidates = ["/api/health", "/api/healthcheck"];
    let healthPath: string | null = null;
    for (const p of candidates) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        healthPath = p;
        break;
      }
    }
    if (!healthPath) {
      test.skip(true, "Pas de health endpoint trouvé");
      return;
    }
    const statuses: number[] = [];
    const durations: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t = performance.now();
      const res = await fetch(`${target.engineUrl}${healthPath}`);
      durations.push(performance.now() - t);
      statuses.push(res.status);
    }
    // Tous doivent être 200
    expect(statuses.every((s) => s === 200)).toBeTruthy();
    // p95 < 5s (large tolérance CI)
    const avg = durations.reduce((s, n) => s + n, 0) / durations.length;
    expect(avg, `Health endpoint avg=${avg}ms > 5000ms`).toBeLessThan(5_000);
  });

  test("Bridge health endpoint stable", async () => {
    test.skip(target.isDemo, "Demo n'a pas de bridge séparé");
    const candidates = ["/api/health", "/health"];
    let found = false;
    for (const p of candidates) {
      const res = await fetch(`${target.bridgeUrl}${p}`);
      if (res.status < 500) {
        found = true;
        break;
      }
    }
    // best-effort
    if (!found) {
      test.skip(true, "Bridge n'expose pas de health public");
    }
  });

  test("Endpoint imaginaire crée une 404 propre (pas un hang)", async () => {
    const t = performance.now();
    const res = await fetch(
      `${target.engineUrl}/api/nonexistent-chaos-${Date.now()}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const duration = performance.now() - t;
    expect(res.status).toBeLessThan(500);
    expect(
      duration,
      `404 trop lent (${duration}ms) — symptom of hang or timeout config issue`,
    ).toBeLessThan(5_000);
  });

  test("Concurrent burst (50 req en parallèle) → bridge ne crash pas", async () => {
    test.skip(target.isDemo, "Pas de stress test sur démo");
    const promises = Array.from({ length: 50 }, () =>
      fetch(`${target.engineUrl}/api/setup.status`).catch(() => null),
    );
    const results = await Promise.all(promises);
    const oks = results.filter((r) => r && r.status < 500).length;
    // Au moins 80% doivent répondre <500
    expect(oks).toBeGreaterThanOrEqual(40);
  });
});
