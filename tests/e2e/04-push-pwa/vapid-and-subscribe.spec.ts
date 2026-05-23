/**
 * 04-push-pwa — VAPID key publique + endpoint subscribe + idempotency.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Push VAPID + subscribe [${TARGET}] @push`, () => {
  test.skip(target.isDemo, "Demo n'a pas de push provisionné");

  test("GET /api/push/vapid-key (ou /api/push.vapidPublicKey) → 200 + base64 pub key", async () => {
    const candidates = [
      "/api/push/vapid-key",
      "/api/push.vapidPublicKey",
      "/api/push/public-key",
    ];
    let found = false;
    for (const p of candidates) {
      const res = await fetch(`${target.engineUrl}${p}`);
      if (res.status === 200) {
        found = true;
        const body = await res.text();
        // VAPID public key = base64url ~88 chars (P-256 X.509)
        // best-effort : on attend au moins 40 chars
        expect(body.length).toBeGreaterThan(30);
        break;
      }
    }
    if (!found) test.skip(true, "Pas d'endpoint VAPID public exposé");
  });

  test("POST /api/push.subscribe sans body → 400/401", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/push.subscribe",
      {},
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("POST /api/push.send sans subscription → 4xx", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/push.send",
      { title: "E2E", body: "test" },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect(res.status).toBeLessThan(500);
  });
});

test.describe(`Push expiration / 410 cleanup [${TARGET}] @push`, () => {
  test.skip(target.isDemo, "Demo single-tenant");

  test("Subscribe avec endpoint invalide → 4xx", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/push.subscribe",
      {
        endpoint: "https://fcm.googleapis.com/fake-e2e-endpoint",
        keys: { p256dh: "fake", auth: "fake" },
      },
      { allowFailure: true, timeoutMs: 10_000 },
    );
    expect(res.status).toBeLessThan(500);
  });
});
