/**
 * Helpers pour attendre que des données soient visibles côté ClickHouse via
 * staminads `/api/analytics.query`.
 *
 * ClickHouse a une latence d'écriture/lecture (1-5s). On poll avec timeout
 * raisonnable (30s) plutôt que sleep en aveugle.
 *
 * Usage typique :
 *   await waitForPageviews(client, wsId, { adminToken, atLeast: 1 });
 */

import { pollUntil } from "./retry";
import type { ApiClient } from "./api-client";

export interface AnalyticsQueryRow {
  [k: string]: string | number;
}

export interface AnalyticsQueryResult {
  rows: AnalyticsQueryRow[];
}

export interface WaitClickhouseOptions {
  /** Bearer token admin staminads. */
  adminToken: string;
  /** Compteur minimum attendu (default 1). */
  atLeast?: number;
  /** Timeout total (default 30s). */
  timeoutMs?: number;
  /** Polling interval (default 1s). */
  intervalMs?: number;
}

/**
 * Attend qu'au moins N pageviews soient visibles dans staminads pour ce ws.
 */
export async function waitForPageviews(
  client: ApiClient,
  workspaceId: string,
  opts: WaitClickhouseOptions,
): Promise<number> {
  const min = opts.atLeast ?? 1;
  return pollUntil(
    async () => {
      const res = await client.post(
        "/api/analytics.query",
        {
          workspace_id: workspaceId,
          metrics: ["pageviews"],
          dimensions: [],
          dateRange: { type: "last_24_hours" },
        },
        {
          headers: { Authorization: `Bearer ${opts.adminToken}` },
          allowFailure: true,
        },
      );
      if (res.status !== 200) {
        throw new Error(
          `analytics.query failed status=${res.status} body=${res.body.slice(0, 200)}`,
        );
      }
      const data = res.json() as AnalyticsQueryResult;
      const row = data.rows?.[0] ?? {};
      const count = Number(row.pageviews ?? 0);
      if (count < min) {
        throw new Error(`pageviews count=${count} < ${min}`);
      }
      return count;
    },
    {
      timeoutMs: opts.timeoutMs ?? 30_000,
      intervalMs: opts.intervalMs ?? 1_500,
      label: `pageviews>=${min} for ws=${workspaceId}`,
    },
  );
}

/**
 * Attend qu'au moins N goal events (proxy "form_submission") soient visibles.
 */
export async function waitForGoals(
  client: ApiClient,
  workspaceId: string,
  opts: WaitClickhouseOptions,
): Promise<number> {
  const min = opts.atLeast ?? 1;
  return pollUntil(
    async () => {
      const res = await client.post(
        "/api/analytics.query",
        {
          workspace_id: workspaceId,
          metrics: ["goals"],
          dimensions: [],
          dateRange: { type: "last_24_hours" },
        },
        {
          headers: { Authorization: `Bearer ${opts.adminToken}` },
          allowFailure: true,
        },
      );
      if (res.status !== 200) {
        throw new Error(
          `analytics.query failed status=${res.status} body=${res.body.slice(0, 200)}`,
        );
      }
      const data = res.json() as AnalyticsQueryResult;
      const row = data.rows?.[0] ?? {};
      const count = Number(row.goals ?? 0);
      if (count < min) {
        throw new Error(`goals count=${count} < ${min}`);
      }
      return count;
    },
    {
      timeoutMs: opts.timeoutMs ?? 30_000,
      intervalMs: opts.intervalMs ?? 1_500,
      label: `goals>=${min} for ws=${workspaceId}`,
    },
  );
}
