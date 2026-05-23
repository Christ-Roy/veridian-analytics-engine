/**
 * 01-smoke — Healthcheck engine + bridge.
 *
 * Le test le plus bloquant de toute la batterie : si /health ne répond pas
 * 200, on rollback. Tourne en moins de 5s par cible.
 *
 * Cibles : staging / prod / demo-prod / demo-staging — sélectionnées via
 * env TARGET (default: staging). Workflows CI mappent TARGET=prod sur le job
 * post-deploy prod.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

test.describe(`Smoke healthcheck [${TARGET}]`, () => {
  test("engine /api/setup.status → 200 + JSON valide", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.get("/api/setup.status", {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    expect(res.status, `engine status (${target.engineUrl})`).toBe(200);
    const body = res.json() as { setupCompleted: boolean };
    expect(body).toHaveProperty("setupCompleted");
    expect(typeof body.setupCompleted).toBe("boolean");
    // Démo doit être en setupCompleted=true (déjà initialisée).
    if (target.isDemo) {
      expect(body.setupCompleted).toBe(true);
    }
  });

  test("bridge /health → 200 + status:ok + staminadsUrl", async () => {
    // Sur les démos, le bridge est interne (pas exposé). On ne teste que
    // sur staging/prod où bridgeUrl est public.
    test.skip(target.isDemo, "Demo n'a pas de bridge public");
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get("/health", { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    const body = res.json() as { status: string; staminadsUrl: string };
    expect(["ok", "healthy"]).toContain(body.status);
    expect(body).toHaveProperty("staminadsUrl");
    expect(typeof body.staminadsUrl).toBe("string");
    expect(body.staminadsUrl.length).toBeGreaterThan(0);
  });

  test("bridge /api/admin/shadow-marketing → 6 services connus", async () => {
    test.skip(target.isDemo, "Demo n'a pas de bridge public");
    const client = new ApiClient(target.bridgeUrl);
    const res = await client.get("/api/admin/shadow-marketing", {
      timeoutMs: 10_000,
    });
    expect(res.status).toBe(200);
    const body = res.json() as Record<string, unknown>;
    const keys = Object.keys(body);
    for (const k of ["calls", "forms", "pageviews", "gsc", "ads", "pagespeed"]) {
      expect(keys, `service "${k}" missing`).toContain(k);
    }
  });

  test("demo: GET /api/public-config → is_demo:true sur les cibles démo", async () => {
    test.skip(!target.isDemo, "Test démo only");
    const client = new ApiClient(target.consoleUrl);
    const res = await client.get("/api/public-config", { timeoutMs: 10_000 });
    expect(res.status).toBe(200);
    const body = res.json() as {
      is_demo: boolean;
      demo_workspace_id: string;
      contact_email: string;
    };
    expect(body.is_demo).toBe(true);
    expect(body.demo_workspace_id).toBeTruthy();
    expect(body.contact_email).toMatch(/@veridian\.site$/);
  });

  test("demo: GET /api/public-config → is_demo:false sur staging/prod", async () => {
    test.skip(target.isDemo, "Test non-démo only");
    const client = new ApiClient(target.consoleUrl);
    const res = await client.get("/api/public-config", {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    // L'endpoint peut renvoyer 200 avec is_demo:false, OU 404 si pas implémenté
    // (les anciennes versions n'ont pas cet endpoint). On accepte les 2.
    if (res.status === 200) {
      const body = res.json() as { is_demo?: boolean };
      if (body.is_demo !== undefined) {
        expect(body.is_demo).toBe(false);
      }
    } else {
      expect([404, 200]).toContain(res.status);
    }
  });
});
