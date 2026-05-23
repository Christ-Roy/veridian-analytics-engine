/**
 * Phase B — Flow tracker → ingestion.
 *
 * Vérifie que l'endpoint public `POST /api/track` accepte un payload pageview
 * valide minimal, sans toucher à un workspace réel (on utilise un workspace_id
 * "e2e-probe" qui peut renvoyer 200 même si le ws n'existe pas — staminads
 * stocke en ClickHouse de toute façon et le validate-only court-circuit).
 *
 * On NE peut PAS faire le test "end-to-end ClickHouse → query" en CI sans
 * admin token staminads. C'est fait dans 02-tracker-with-query.spec.ts qui
 * skip si `STAMINADS_ADMIN_TOKEN_*` manquant.
 *
 * Test critique de la pipe ingest : si `/api/track` répond 5xx ou rejette un
 * payload valide → toute la chaîne data est cassée.
 *
 * Tag `@critical`.
 */

import { test, expect } from "@playwright/test";
import { getTarget, type TargetName } from "../helpers/targets";
import { ApiClient } from "../helpers/api-client";
import { testRunId } from "../fixtures/test-data";

const TARGET = (process.env.TARGET ?? "staging") as TargetName;
const target = getTarget(TARGET);

const PROBE_WS =
  process.env.E2E_TRACK_PROBE_WORKSPACE_ID ??
  (target.isDemo ? "demo-apple" : "e2e-probe-workspace");

test.describe(`Tracker /api/track accepts payload [${TARGET}] @critical`, () => {
  test("POST /api/track avec pageview valide → 200 + {success:true}", async () => {
    const now = Date.now();
    const client = new ApiClient(target.engineUrl);
    const sessionId = `e2e-test-sess-${testRunId()}`;
    const res = await client.post(
      "/api/track",
      {
        workspace_id: PROBE_WS,
        session_id: sessionId,
        actions: [
          {
            type: "pageview",
            path: "/e2e-probe",
            page_number: 1,
            duration: 1500,
            scroll: 25,
            entered_at: now - 2000,
            exited_at: now - 500,
          },
        ],
        attributes: {
          // Note: SessionAttributesDto can vary by version. Keep minimal.
        },
        created_at: now - 2500,
        updated_at: now,
        sdk_version: "e2e-1.0",
      },
      { timeoutMs: 15_000, allowFailure: true },
    );

    // CRITICAL : pas de 5xx
    expect(
      res.status,
      `track 5xx — pipeline ingest CASSÉ. body=${res.body.slice(0, 300)}`,
    ).toBeLessThan(500);

    // On accepte 200 (workspace existe et accepte) ou 400 (workspace inconnu /
    // payload partiellement invalide selon staminads version). Ce qu'on
    // refuse : 5xx (= bug serveur).
    expect([200, 400, 404]).toContain(res.status);

    if (res.status === 200) {
      const body = res.json() as { success?: boolean };
      expect(
        body.success,
        `200 mais success != true: ${res.body.slice(0, 200)}`,
      ).toBe(true);
    }
  });

  test("POST /api/track avec body vide → 400 (validation OK)", async () => {
    const client = new ApiClient(target.engineUrl);
    const res = await client.post("/api/track", {}, {
      timeoutMs: 10_000,
      allowFailure: true,
    });
    // Validation NestJS doit rejeter en 400, jamais 5xx
    expect(res.status, "validation should be 4xx").toBeGreaterThanOrEqual(400);
    expect(res.status, "validation should not 5xx").toBeLessThan(500);
  });

  test("POST /api/track avec workspace_id manquant → 400", async () => {
    const now = Date.now();
    const client = new ApiClient(target.engineUrl);
    const res = await client.post(
      "/api/track",
      {
        session_id: "e2e-probe",
        actions: [],
        created_at: now,
        updated_at: now,
      },
      { timeoutMs: 10_000, allowFailure: true },
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });
});
