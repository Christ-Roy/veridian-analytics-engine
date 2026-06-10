/**
 * Integration test : full path GSC.
 *
 * Démarre un Express avec `registerGscRoutes()` connecté à un FakePrismaClient
 * et un mock Google. Exécute :
 *   1. POST /api/admin/gsc/oauth-begin?tenantId=...  → URL Google
 *   2. GET  /api/admin/gsc/oauth-callback?code=X&state=...  → tokens persistés
 *   3. (sim de vérification GSC : on bascule la property à verified avec siteUrl réel)
 *   4. POST /api/admin/gsc/sync?gscPropertyId=...   → rows insérées
 *   5. GET  /api/admin/tenant/:workspaceId/gsc      → dashboard summary
 *   6. POST /api/admin/gsc/sync-all                 → loop sync
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  registerGscRoutes,
  type GscRoutesDeps,
} from "../../src/gsc/routes.js";
import {
  buildState,
  encryptTokens,
  type OauthConfig,
  type OauthTokens,
  type GscRawRow,
} from "../../src/gsc/index.js";
import { FakePrismaClient } from "../helpers/fake-prisma.js";

const KEY = "e".repeat(64);
const ADMIN_KEY = "veridian-test-admin-key-32-chars!";
const CFG: OauthConfig = {
  clientId: "ci",
  clientSecret: "cs",
  redirectUri: "https://b/cb",
  encryptionKey: KEY,
};

interface Started {
  url: string;
  close: () => Promise<void>;
}

function makeMockGoogle(googleRows: GscRawRow[]): typeof fetch {
  return (async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.includes("oauth2.googleapis.com/token")) {
      const body = new URLSearchParams((init?.body as string) ?? "");
      if (body.get("grant_type") === "authorization_code") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "AT_NEW",
            refresh_token: "RT_NEW",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/webmasters.readonly",
            token_type: "Bearer",
          }),
          text: async () => "",
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: "AT_REFRESHED", expires_in: 3600 }),
        text: async () => "",
      } as unknown as Response;
    }
    if (url.includes("searchconsole.googleapis.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ rows: googleRows }),
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "not_mocked" }),
      text: async () => "not_mocked",
    } as unknown as Response;
  }) as typeof fetch;
}

async function startApp(deps: GscRoutesDeps): Promise<Started> {
  const app = express();
  app.use(express.json());
  registerGscRoutes(app, deps);
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

let prisma: FakePrismaClient;
let started: Started;

beforeEach(async () => {
  prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_int", workspaceId: "ws_int", slug: "int", name: "Int" },
  });
});

afterEach(async () => {
  if (started) await started.close();
});

test("E2E: oauth-begin → callback → sync → dashboard", async () => {
  // Date dynamique : le dashboard agrège sur une fenêtre glissante
  // (days=30 depuis maintenant) — une date en dur sort de la fenêtre
  // avec le temps et fait pourrir le test (cassé à partir du 2026-06-04).
  const recentDate = new Date(Date.now() - 7 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const googleRows: GscRawRow[] = [
    {
      keys: [recentDate, "veridian seo", "/pricing", "fra", "desktop"],
      clicks: 25,
      impressions: 300,
      ctr: 0.083,
      position: 3.2,
    },
  ];
  const fetchImpl = makeMockGoogle(googleRows);

  started = await startApp({
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    oauthConfig: CFG,
    adminApiKey: ADMIN_KEY,
    requireAdmin: (req, res, next) => {
      const a = req.header("authorization");
      if (a === `Bearer ${ADMIN_KEY}`) next();
      else res.status(401).json({ error: "no_auth" });
    },
    fetchImpl,
  });

  const beginRes = await fetch(
    `${started.url}/api/admin/gsc/oauth-begin?tenantId=tenant_int`,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(beginRes.status, 200);
  const beginBody = (await beginRes.json()) as { url: string; state: string };
  assert.ok(beginBody.url.startsWith("https://accounts.google.com"));
  assert.ok(beginBody.state.startsWith("tenant_int."));

  const cbRes = await fetch(
    `${started.url}/api/admin/gsc/oauth-callback?code=ABC&state=${encodeURIComponent(beginBody.state)}`,
  );
  assert.equal(cbRes.status, 200);
  const cbBody = (await cbRes.json()) as { ok: boolean; tenantId: string };
  assert.equal(cbBody.tenantId, "tenant_int");
  assert.equal(prisma.gscProperties.length, 1);
  assert.equal(prisma.gscProperties[0].siteUrl, "__pending__");

  // Simulate ownership verification
  const placeholder = prisma.gscProperties[0];
  placeholder.siteUrl = "https://example.com/";
  placeholder.ownershipState = "verified";

  const syncRes = await fetch(
    `${started.url}/api/admin/gsc/sync?gscPropertyId=${placeholder.id}&days=7`,
    { method: "POST", headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(syncRes.status, 200);
  const syncBody = (await syncRes.json()) as { upserted: number };
  assert.equal(syncBody.upserted, 1);
  assert.equal(prisma.gscDailies.length, 1);

  const dashRes = await fetch(
    `${started.url}/api/admin/tenant/ws_int/gsc?days=30`,
    { headers: { Authorization: `Bearer ${ADMIN_KEY}` } },
  );
  assert.equal(dashRes.status, 200);
  const dashBody = (await dashRes.json()) as {
    property: { id: string } | null;
    totals: { clicks: number };
    topQueries: Array<{ keys: string[]; clicks: number }>;
  };
  assert.equal(dashBody.property?.id, placeholder.id);
  assert.equal(dashBody.totals.clicks, 25);
  assert.equal(dashBody.topQueries[0].keys[0], "veridian seo");
});

test("oauth-begin requires admin", async () => {
  started = await startApp({
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    oauthConfig: CFG,
    adminApiKey: ADMIN_KEY,
    requireAdmin: (req, res, next) => {
      if (req.header("authorization") === `Bearer ${ADMIN_KEY}`) next();
      else res.status(401).json({ error: "no_auth" });
    },
    fetchImpl: makeMockGoogle([]),
  });
  const res = await fetch(
    `${started.url}/api/admin/gsc/oauth-begin?tenantId=tenant_int`,
    { method: "POST" },
  );
  assert.equal(res.status, 401);
});

test("sync-all rejects without bearer or IP allowlist", async () => {
  started = await startApp({
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    oauthConfig: CFG,
    adminApiKey: ADMIN_KEY,
    requireAdmin: (_req, _res, next) => next(),
    fetchImpl: makeMockGoogle([]),
  });
  const res = await fetch(`${started.url}/api/admin/gsc/sync-all`, {
    method: "POST",
  });
  assert.equal(res.status, 401);
});

test("sync-all accepts bearer admin", async () => {
  const tokens: OauthTokens = {
    access_token: "AT",
    refresh_token: "RT",
    expires_at: Date.now() + 3600_000,
    scope: "s",
    token_type: "Bearer",
  };
  await prisma.gscProperty.create({
    data: {
      tenantId: "tenant_int",
      siteUrl: "https://example.com/",
      type: "SITE",
      ownershipState: "verified",
      oauthAccount: encryptTokens(tokens, KEY),
    },
  });
  started = await startApp({
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    oauthConfig: CFG,
    adminApiKey: ADMIN_KEY,
    requireAdmin: (_req, _res, next) => next(),
    fetchImpl: makeMockGoogle([]),
  });
  const res = await fetch(`${started.url}/api/admin/gsc/sync-all`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ADMIN_KEY}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { count: number };
  assert.equal(body.count, 1);
});

test("oauth-callback rejects tampered state", async () => {
  started = await startApp({
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    oauthConfig: CFG,
    adminApiKey: ADMIN_KEY,
    requireAdmin: (_req, _res, next) => next(),
    fetchImpl: makeMockGoogle([]),
  });
  const state = buildState("tenant_int", KEY);
  const tampered = state.replace("tenant_int", "tenant_evil");
  const res = await fetch(
    `${started.url}/api/admin/gsc/oauth-callback?code=ABC&state=${encodeURIComponent(tampered)}`,
  );
  assert.equal(res.status, 400);
});
