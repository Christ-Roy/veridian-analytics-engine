/**
 * 02-tracker — Le tracker peut envoyer plusieurs events dans un seul batch.
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

test.describe(`Tracker batch events [${TARGET}] @tracker`, () => {
  test("Plusieurs pageviews dans le même payload → 200/2xx ou 4xx clean", async () => {
    const now = Date.now();
    const client = new ApiClient(target.engineUrl);
    const sessionId = `e2e-batch-${testRunId()}`;
    const res = await client.post(
      "/api/track",
      {
        workspace_id: PROBE_WS,
        session_id: sessionId,
        actions: [
          {
            type: "pageview",
            path: "/e2e-batch-1",
            page_number: 1,
            duration: 1000,
            scroll: 50,
            entered_at: now - 5000,
            exited_at: now - 4000,
          },
          {
            type: "pageview",
            path: "/e2e-batch-2",
            page_number: 2,
            duration: 1500,
            scroll: 75,
            entered_at: now - 4000,
            exited_at: now - 2500,
          },
          {
            type: "pageview",
            path: "/e2e-batch-3",
            page_number: 3,
            duration: 800,
            scroll: 30,
            entered_at: now - 2500,
            exited_at: now - 1700,
          },
        ],
        attributes: {},
        created_at: now - 5500,
        updated_at: now,
        sdk_version: "e2e-batch-1.0",
      },
      { timeoutMs: 15_000, allowFailure: true },
    );

    expect(res.status).toBeLessThan(500);
    expect([200, 400, 404]).toContain(res.status);
  });

  test("Payload énorme (1000 actions) → rejet propre 413 ou 400 (pas 500)", async () => {
    const now = Date.now();
    const client = new ApiClient(target.engineUrl);
    const actions = Array.from({ length: 1000 }, (_, i) => ({
      type: "pageview" as const,
      path: `/e2e-huge-${i}`,
      page_number: i + 1,
      duration: 100,
      scroll: 10,
      entered_at: now - 100_000 + i * 100,
      exited_at: now - 100_000 + i * 100 + 50,
    }));
    const res = await client.post(
      "/api/track",
      {
        workspace_id: PROBE_WS,
        session_id: `e2e-huge-${testRunId()}`,
        actions,
        attributes: {},
        created_at: now,
        updated_at: now,
        sdk_version: "e2e-huge",
      },
      { timeoutMs: 30_000, allowFailure: true },
    );
    // 200 (accepted) ou 400/413 (size limit) — pas 500
    expect(res.status).toBeLessThan(500);
  });
});
