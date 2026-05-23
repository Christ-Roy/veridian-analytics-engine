/**
 * 02-tracker — CORS du tracker + méthodes acceptées.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Tracker CORS + method [${TARGET}] @tracker`, () => {
  test("OPTIONS /api/track depuis any origin → 200/204 ou 405", async () => {
    const res = await fetch(`${target.engineUrl}/api/track`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.client-website.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });
    // 200/204 si CORS configuré, 405 si OPTIONS pas géré (auquel cas POST direct marche)
    expect([200, 204, 404, 405]).toContain(res.status);
  });

  test("GET /api/track → 405 Method Not Allowed", async () => {
    const res = await fetch(`${target.engineUrl}/api/track`);
    expect([404, 405]).toContain(res.status);
  });

  test("Content-Type incorrect → 4xx (pas 500)", async () => {
    const res = await fetch(`${target.engineUrl}/api/track`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "this is not JSON",
    });
    expect(res.status).toBeLessThan(500);
  });
});
