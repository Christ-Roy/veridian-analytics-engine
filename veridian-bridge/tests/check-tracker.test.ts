/**
 * Tests GET /api/admin/tenant/:workspaceId/check-tracker
 *
 * Endpoint de l'onboarding wizard `/welcome` (U4 / ex-C3). Stratégie : on
 * injecte un `recentActivityFetcher` mocké directement dans createApp() au
 * lieu de monter le fake-staminads — plus rapide, plus déterministe. Le
 * chemin staminads réel (makeStaminadsRecentActivityFetcher) reste couvert
 * indirectement par analytics.test.ts qui exerce le même analytics.query.
 *
 * Cas couverts (cf. ticket C3) :
 *   1. workspace 0 event           → status: 'waiting', firstSeenAt: null
 *   2. workspace avec events       → status: 'ok' + firstSeenAt
 *   3. requête sans Bearer         → 401 missing_bearer (fetcher pas appelé)
 *   4. mauvaise clé Bearer         → 403 invalid_admin_key
 *   5. workspace inconnu (0 event) → 200 waiting (pas une erreur)
 *   6. firstSeenAt forcé null si waiting même si le fetcher en renvoie un
 *   7. exception du fetcher        → 500 internal
 *   8. helper makeStaminadsRecentActivityFetcher : parse rows, somme,
 *      earliest date, et fail-safe (staminads down → activité nulle)
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { startAppOnEphemeralPort } from "./helpers/fake-staminads.js";
import {
  makeStaminadsRecentActivityFetcher,
  type RecentActivity,
  type RecentActivityFetcher,
} from "../src/check-tracker.js";

const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

interface Ctx {
  url: string;
  close: () => Promise<void>;
  fetcherCalls: string[];
}

async function bootBridge(
  activityByWorkspace: Record<string, RecentActivity>,
  opts: { throwOn?: string } = {},
): Promise<Ctx> {
  const fetcherCalls: string[] = [];
  const fetcher: RecentActivityFetcher = async (workspaceId) => {
    fetcherCalls.push(workspaceId);
    if (opts.throwOn && workspaceId === opts.throwOn) {
      throw new Error("boom staminads");
    }
    return (
      activityByWorkspace[workspaceId] ?? {
        totalEvents24h: 0,
        firstSeenAt: null,
      }
    );
  };
  const app = createApp(
    {
      staminadsUrl: "http://127.0.0.1:1", // jamais appelé (fetcher injecté)
      adminEmail: "admin@veridian.local",
      adminPassword: "test-pass-2026",
      veridianAdminApiKey: ADMIN_KEY,
    },
    { recentActivityFetcher: fetcher },
  );
  const started = await startAppOnEphemeralPort(app);
  return { url: started.url, close: started.close, fetcherCalls };
}

let ctx: Ctx | undefined;
afterEach(async () => {
  if (ctx) {
    await ctx.close();
    // Réinitialisé : les tests du helper (sans bridge) ne doivent pas
    // re-fermer un serveur déjà clos → ERR_SERVER_NOT_RUNNING.
    ctx = undefined;
  }
});

async function checkTracker(workspaceId: string, withAuth = true) {
  if (!ctx) throw new Error("ctx not booted — call bootBridge() first");
  return fetch(
    `${ctx.url}/api/admin/tenant/${workspaceId}/check-tracker`,
    {
      headers: withAuth ? { Authorization: `Bearer ${ADMIN_KEY}` } : {},
    },
  );
}

interface CheckTrackerBody {
  status: "ok" | "waiting";
  firstSeenAt: string | null;
  totalEvents24h: number;
}

test("check-tracker: workspace 0 event → status waiting, firstSeenAt null", async () => {
  ctx = await bootBridge({ ws_empty: { totalEvents24h: 0, firstSeenAt: null } });
  const res = await checkTracker("ws_empty");
  assert.equal(res.status, 200);
  const body = (await res.json()) as CheckTrackerBody;
  assert.equal(body.status, "waiting");
  assert.equal(body.firstSeenAt, null);
  assert.equal(body.totalEvents24h, 0);
  assert.equal(ctx.fetcherCalls.length, 1);
  assert.equal(ctx.fetcherCalls[0], "ws_empty");
});

test("check-tracker: workspace avec 1 event → status ok + firstSeenAt", async () => {
  ctx = await bootBridge({
    ws_live: {
      totalEvents24h: 1,
      firstSeenAt: "2026-05-22T00:00:00.000Z",
    },
  });
  const res = await checkTracker("ws_live");
  assert.equal(res.status, 200);
  const body = (await res.json()) as CheckTrackerBody;
  assert.equal(body.status, "ok");
  assert.equal(body.firstSeenAt, "2026-05-22T00:00:00.000Z");
  assert.equal(body.totalEvents24h, 1);
});

test("check-tracker: workspace avec beaucoup d'events → status ok", async () => {
  ctx = await bootBridge({
    ws_busy: {
      totalEvents24h: 4218,
      firstSeenAt: "2026-05-21T00:00:00.000Z",
    },
  });
  const res = await checkTracker("ws_busy");
  const body = (await res.json()) as CheckTrackerBody;
  assert.equal(body.status, "ok");
  assert.equal(body.totalEvents24h, 4218);
});

test("check-tracker: sans Bearer → 401 missing_bearer", async () => {
  ctx = await bootBridge({ ws_any: { totalEvents24h: 99, firstSeenAt: null } });
  const res = await checkTracker("ws_any", false);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "missing_bearer");
  // Le fetcher ne doit jamais être appelé quand l'auth échoue.
  assert.equal(ctx.fetcherCalls.length, 0);
});

test("check-tracker: mauvaise clé Bearer → 403 invalid_admin_key", async () => {
  ctx = await bootBridge({ ws_any: { totalEvents24h: 1, firstSeenAt: null } });
  const res = await fetch(
    `${ctx.url}/api/admin/tenant/ws_any/check-tracker`,
    { headers: { Authorization: "Bearer wrong-key" } },
  );
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_admin_key");
  assert.equal(ctx.fetcherCalls.length, 0);
});

test("check-tracker: workspace inconnu → 200 waiting (pas une erreur)", async () => {
  // Un workspace jamais provisionné côté staminads ne lève pas 404 : le
  // fetcher retourne 0 event, le wizard continue d'attendre.
  ctx = await bootBridge({});
  const res = await checkTracker("ws_never_seen");
  assert.equal(res.status, 200);
  const body = (await res.json()) as CheckTrackerBody;
  assert.equal(body.status, "waiting");
  assert.equal(body.totalEvents24h, 0);
});

test("check-tracker: firstSeenAt forcé null quand status waiting", async () => {
  // Garde-fou : même si le fetcher renvoyait un firstSeenAt incohérent avec
  // 0 event, le handler ne l'expose pas tant que status !== 'ok'.
  ctx = await bootBridge({
    ws_weird: {
      totalEvents24h: 0,
      firstSeenAt: "2026-05-22T00:00:00.000Z",
    },
  });
  const res = await checkTracker("ws_weird");
  const body = (await res.json()) as CheckTrackerBody;
  assert.equal(body.status, "waiting");
  assert.equal(body.firstSeenAt, null);
});

test("check-tracker: exception du fetcher → 500 internal", async () => {
  ctx = await bootBridge(
    { ws_boom: { totalEvents24h: 0, firstSeenAt: null } },
    { throwOn: "ws_boom" },
  );
  const res = await checkTracker("ws_boom");
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error: string; message: string };
  assert.equal(body.error, "internal");
  assert.equal(body.message, "boom staminads");
});

// ─── makeStaminadsRecentActivityFetcher (helper HTTP) ─────────────────────

test("recentActivityFetcher: somme les pageviews + earliest date", async () => {
  let captured: unknown = null;
  // On monte un faux staminads minimal qui renvoie 3 jours de data.
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const parsed = JSON.parse(raw || "{}") as { workspace_id?: string };
      captured = parsed.workspace_id;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          rows: [
            { date: "2026-05-22", pageviews: 5 },
            { date: "2026-05-20", pageviews: 12 },
            { date: "2026-05-21", pageviews: 0 },
          ],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const fetcher = makeStaminadsRecentActivityFetcher({
    staminadsUrl: `http://127.0.0.1:${port}`,
    getAdminToken: async () => "fake-token",
  });

  const activity = await fetcher("ws_demo");
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.equal(captured, "ws_demo");
  assert.equal(activity.totalEvents24h, 17); // 5 + 12 + 0
  // earliest date AVEC pageviews > 0 → 2026-05-20 (le 21 a 0 PV, ignoré)
  assert.equal(activity.firstSeenAt, "2026-05-20T00:00:00.000Z");
});

test("recentActivityFetcher: staminads down → activité nulle (fail-safe)", async () => {
  // Aucun serveur n'écoute → fetch rejette → on retourne 0 plutôt que throw.
  const fetcher = makeStaminadsRecentActivityFetcher({
    staminadsUrl: "http://127.0.0.1:1",
    getAdminToken: async () => "fake-token",
  });
  const activity = await fetcher("ws_any");
  assert.equal(activity.totalEvents24h, 0);
  assert.equal(activity.firstSeenAt, null);
});

test("recentActivityFetcher: staminads renvoie 500 → activité nulle", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.end("clickhouse_down");
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  const fetcher = makeStaminadsRecentActivityFetcher({
    staminadsUrl: `http://127.0.0.1:${port}`,
    getAdminToken: async () => "fake-token",
  });
  const activity = await fetcher("ws_any");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  assert.equal(activity.totalEvents24h, 0);
  assert.equal(activity.firstSeenAt, null);
});
