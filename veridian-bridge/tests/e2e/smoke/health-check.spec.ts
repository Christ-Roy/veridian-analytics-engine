/**
 * Smoke 01 — Health check du bridge.
 *
 * Volontairement minimaliste. Tourne en post-deploy CI pour valider que le
 * bridge répond. Pas de Bearer requis — endpoint public.
 *
 * Mode :
 *  - CI staging : BRIDGE_URL=https://analytics-engine-bridge.staging.veridian.site
 *  - CI prod    : BRIDGE_URL=https://analytics-engine-bridge.app.veridian.site
 *  - Local      : boot un bridge local via bootBridgeForTest()
 */

import { test, expect } from "@playwright/test";
import {
  bootBridgeForTest,
  type BridgeFixture,
} from "../helpers/bridge-fixture.js";

const REMOTE_URL = process.env.BRIDGE_URL || "";

let localBridge: BridgeFixture | null = null;
let baseUrl = REMOTE_URL;

test.beforeAll(async () => {
  if (!REMOTE_URL) {
    localBridge = await bootBridgeForTest();
    baseUrl = localBridge.url;
  }
});

test.afterAll(async () => {
  if (localBridge) {
    await localBridge.close();
  }
});

test.describe("Bridge health", () => {
  test("GET /health → 200 + JSON status:ok", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("status");
    expect(["ok", "healthy"]).toContain(body.status);
  });

  test("GET /health retourne staminadsUrl (config check)", async () => {
    const res = await fetch(`${baseUrl}/health`);
    const body = await res.json();
    // Sur local : URL fake 127.0.0.1. Sur remote : staminads:3000 ou URL prod.
    expect(body).toHaveProperty("staminadsUrl");
    expect(typeof body.staminadsUrl).toBe("string");
  });

  test("GET /api/admin/shadow-marketing (public) → 200 + 6 services au top-level", async () => {
    const res = await fetch(`${baseUrl}/api/admin/shadow-marketing`);
    expect(res.status).toBe(200);
    const body = await res.json();
    // L'endpoint retourne directement le Record (pas wrappé sous "services")
    const keys = Object.keys(body);
    expect(keys.length).toBeGreaterThanOrEqual(6);
    for (const k of ["calls", "forms", "pageviews", "gsc", "ads", "pagespeed"]) {
      expect(keys).toContain(k);
    }
  });
});
