/**
 * Smoke 02 — Cold start du bridge.
 *
 * Vérifie que le bridge boot rapidement (< 5s) et répond à /health avant 5s.
 * Pas de Bearer requis.
 *
 * Local only — sur remote (staging/prod), un /health 200 + un time-to-first-byte
 * sain suffisent.
 */

import { test, expect } from "@playwright/test";
import {
  bootBridgeForTest,
  type BridgeFixture,
} from "../helpers/bridge-fixture.js";

test.describe("Cold start", () => {
  test("Bridge boot + /health 200 en < 5s (local only)", async () => {
    if (process.env.BRIDGE_URL) {
      test.skip(true, "Cold start n'a de sens qu'en local");
    }
    const t0 = Date.now();
    const bridge: BridgeFixture = await bootBridgeForTest();
    try {
      const res = await fetch(`${bridge.url}/health`);
      expect(res.status).toBe(200);
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await bridge.close();
    }
  });
});
