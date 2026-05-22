/**
 * Tests unitaires — routes Express settings + credentials (U8).
 *
 * Couvre `src/settings/routes.ts` :
 *   - GET/PUT /api/admin/tenant/:wsId/settings
 *   - GET/POST /api/admin/tenant/:wsId/credentials
 *   - POST /api/admin/tenant/:wsId/credentials/:kind/test
 *   - DELETE /api/admin/tenant/:wsId/credentials/:kind
 *   - auth Bearer (401/403), 404 tenant inconnu, 400 payload invalide
 *   - les creds ne fuitent jamais en clair dans les réponses HTTP
 *
 * Pattern : Express réel + FakePrismaClient + fetch sur port éphémère
 * (comme tests/push/subscribe.test.ts).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { registerSettingsRoutes } from "../src/settings/routes.js";
import { FakePrismaClientWithSettings } from "./helpers/fake-prisma-settings.js";

const KEY = "e".repeat(64);
const ADMIN = "test-admin-key-32-characters-min!";

function mockFetch(status: number): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => "1700000000",
      json: async () => ({}),
    }) as unknown) as typeof fetch;
}

async function bootApp(
  prisma: FakePrismaClientWithSettings,
  fetchImpl?: typeof fetch,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    if (auth.slice("Bearer ".length).trim() !== ADMIN) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  };
  registerSettingsRoutes(app, {
    prisma: prisma as unknown as PrismaClient,
    requireAdmin,
    encryptionKey: KEY,
    fetchImpl,
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function seedTenant(): Promise<FakePrismaClientWithSettings> {
  const prisma = new FakePrismaClientWithSettings();
  await prisma.tenant.create({
    data: {
      id: "t1",
      workspaceId: "ws1",
      slug: "acme",
      name: "Acme",
      plan: "pro",
      status: "active",
    },
  });
  return prisma;
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${ADMIN}`,
    "Content-Type": "application/json",
  };
}

// ─── GET /settings ──────────────────────────────────────────────────────────

test("GET /settings retourne la vue config — 200", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/settings`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      tenant: { name: string };
      notifications: { notifyNewLead: boolean };
    };
    assert.equal(body.tenant.name, "Acme");
    assert.equal(body.notifications.notifyNewLead, true);
  } finally {
    await close();
  }
});

test("GET /settings sans Bearer → 401", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/settings`);
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("GET /settings avec mauvaise clé → 403", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/settings`, {
      headers: { Authorization: "Bearer wrong" },
    });
    assert.equal(res.status, 403);
  } finally {
    await close();
  }
});

test("GET /settings tenant inconnu → 404", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws_nope/settings`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ─── PUT /settings ──────────────────────────────────────────────────────────

test("PUT /settings applique le patch — 200", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/settings`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ notifyNewLead: false, visitorIdEnabled: false }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      notifications: { notifyNewLead: boolean };
      tracking: { visitorIdEnabled: boolean };
    };
    assert.equal(body.notifications.notifyNewLead, false);
    assert.equal(body.tracking.visitorIdEnabled, false);
  } finally {
    await close();
  }
});

test("PUT /settings rejette un champ inconnu → 400", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/settings`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ adminPower: true }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("PUT /settings rejette un email invalide → 400", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/settings`, {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ notifyEmail: "not-an-email" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

// ─── POST /credentials ──────────────────────────────────────────────────────

test("POST /credentials enregistre des creds VoIP — 201, réponse masquée", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEYsupersecretvalue12345" },
      }),
    });
    assert.equal(res.status, 201);
    const raw = await res.text();
    // Le secret ne doit JAMAIS apparaître en clair dans la réponse.
    assert.ok(!raw.includes("KEYsupersecretvalue12345"));
    const body = JSON.parse(raw) as {
      credential: { masked: { apiKey: string }; status: string };
    };
    assert.equal(body.credential.status, "untested");
    assert.match(body.credential.masked.apiKey, /^••••/);
  } finally {
    await close();
  }
});

test("POST /credentials rejette un kind inconnu → 400", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ kind: "voip_carrier_pigeon", creds: {} }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /credentials rejette des creds invalides → 400", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ kind: "voip_telnyx", creds: { apiKey: "x" } }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});

test("POST /credentials tenant inconnu → 404", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(`${url}/api/admin/tenant/ws_nope/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEY01ABCDEF0123456789" },
      }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ─── GET /credentials ───────────────────────────────────────────────────────

test("GET /credentials liste les creds masqués — 200", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEYlistsecretvalue1234567" },
      }),
    });
    const res = await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      headers: authHeaders(),
    });
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes("KEYlistsecretvalue1234567"));
    const body = JSON.parse(raw) as { credentials: unknown[] };
    assert.equal(body.credentials.length, 1);
  } finally {
    await close();
  }
});

// ─── POST /credentials/:kind/test ───────────────────────────────────────────

test("POST /credentials/:kind/test → ok quand provider répond 200", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma, mockFetch(200));
  try {
    await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEY01ABCDEF0123456789" },
      }),
    });
    const res = await fetch(
      `${url}/api/admin/tenant/ws1/credentials/voip_telnyx/test`,
      { method: "POST", headers: authHeaders() },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; status: string };
    assert.equal(body.ok, true);
    assert.equal(body.status, "ok");
  } finally {
    await close();
  }
});

test("POST /credentials/:kind/test → failed quand provider répond 401", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma, mockFetch(401));
  try {
    await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEY01ABCDEF0123456789" },
      }),
    });
    const res = await fetch(
      `${url}/api/admin/tenant/ws1/credentials/voip_telnyx/test`,
      { method: "POST", headers: authHeaders() },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; status: string };
    assert.equal(body.ok, false);
    assert.equal(body.status, "failed");
  } finally {
    await close();
  }
});

test("POST /credentials/:kind/test → 404 si pas de credential enregistré", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma, mockFetch(200));
  try {
    const res = await fetch(
      `${url}/api/admin/tenant/ws1/credentials/voip_telnyx/test`,
      { method: "POST", headers: authHeaders() },
    );
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

// ─── DELETE /credentials/:kind ──────────────────────────────────────────────

test("DELETE /credentials/:kind supprime le credential — 200", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    await fetch(`${url}/api/admin/tenant/ws1/credentials`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        kind: "voip_telnyx",
        creds: { apiKey: "KEY01ABCDEF0123456789" },
      }),
    });
    const res = await fetch(
      `${url}/api/admin/tenant/ws1/credentials/voip_telnyx`,
      { method: "DELETE", headers: authHeaders() },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deleted: boolean };
    assert.equal(body.deleted, true);
    assert.equal(prisma.tenantCredentials.length, 0);
  } finally {
    await close();
  }
});

test("DELETE /credentials/:kind est idempotent — 200 deleted=false", async () => {
  const prisma = await seedTenant();
  const { url, close } = await bootApp(prisma);
  try {
    const res = await fetch(
      `${url}/api/admin/tenant/ws1/credentials/voip_telnyx`,
      { method: "DELETE", headers: authHeaders() },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { deleted: boolean };
    assert.equal(body.deleted, false);
  } finally {
    await close();
  }
});
