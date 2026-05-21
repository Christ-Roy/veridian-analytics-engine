/**
 * Tests subscribe — POST /api/push/subscribe + lib subscribePushClient.
 *
 * Couvre :
 *   - happy path : row créée, status 201
 *   - idempotence : second subscribe sur même endpoint = update (200), pas double-row
 *   - tenant inconnu → 404
 *   - payload invalide (endpoint pas URL, keys manquantes) → 400
 *   - CORS public ouvert (sites clients cross-origin)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerPushRoutes } from "../../src/push/routes.js";
import {
  subscribePushClient,
  _resetForTests,
  configureWebPush,
} from "../../src/push/index.js";
import { FakePrismaClient } from "../helpers/fake-prisma.js";

const VAPID_PUBLIC = "BMa9I_teR6iZfP09lzwy8HnI9fU77rUVajmJTmWv0Iiy7V3R5trzNRdJj1DZt8ewb_-VFX3ZEig190bA5tx6qUo";
const VAPID_PRIVATE = "y5VCetmsjhLXCaaSDjtVQ_KfKkQNcOV6qne7TpjdS_k";

function makeApp(prisma: FakePrismaClient) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization");
    if (auth === "Bearer test-admin-key") return next();
    res.status(401).json({ error: "unauthorized" });
  };
  // typecheck-friendly cast — FakePrismaClient implémente la signature utilisée
  registerPushRoutes(app, {
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    requireAdmin,
  });
  return app;
}

async function seedTenant(prisma: FakePrismaClient, opts?: {
  workspaceId?: string;
  id?: string;
}) {
  return prisma.tenant.create({
    data: {
      id: opts?.id ?? "tenant_t1",
      workspaceId: opts?.workspaceId ?? "veridian_demo",
      slug: "demo",
      name: "Demo",
    },
  });
}

function startServer(app: ReturnType<typeof makeApp>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

test("subscribePushClient creates row on first call (created=true)", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  await seedTenant(prisma);

  const result = await subscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys: { p256dh: "p256_xxx", auth: "auth_yyy" },
      userAgent: "Mozilla/5.0",
      visitorId: "vid_42",
    },
  );

  assert.equal(result.created, true);
  assert.equal(prisma.pushSubs.length, 1);
  assert.equal(prisma.pushSubs[0].tenantId, "tenant_t1");
  assert.equal(prisma.pushSubs[0].active, true);
  assert.equal(prisma.pushSubs[0].visitorId, "vid_42");
});

test("subscribePushClient is idempotent on same endpoint (update, no duplicate)", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  await seedTenant(prisma);

  const r1 = await subscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys: { p256dh: "p1", auth: "a1" },
    },
  );
  const r2 = await subscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    {
      endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
      keys: { p256dh: "p2_updated", auth: "a2_updated" },
    },
  );

  assert.equal(r1.created, true);
  assert.equal(r2.created, false);
  assert.equal(r1.id, r2.id); // même row
  assert.equal(prisma.pushSubs.length, 1);
  assert.deepEqual(prisma.pushSubs[0].keys, {
    p256dh: "p2_updated",
    auth: "a2_updated",
  });
});

test("subscribePushClient reactivates an inactive sub on re-subscribe", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  await seedTenant(prisma);

  await subscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    {
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p", auth: "a" },
    },
  );
  // Simule un cleanup auto 410 Gone
  prisma.pushSubs[0].active = false;

  await subscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    {
      endpoint: "https://push.example/abc",
      keys: { p256dh: "p", auth: "a" },
    },
  );

  assert.equal(prisma.pushSubs[0].active, true);
});

test("POST /api/push/subscribe returns 201 with valid payload", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  await seedTenant(prisma);
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "veridian_demo",
        endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
        keys: { p256dh: "p256x", auth: "authx" },
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { ok: boolean; created: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.created, true);
    // CORS public
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  } finally {
    await close();
  }
});

test("POST /api/push/subscribe returns 404 if tenant unknown", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "ghost_ws",
        endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
        keys: { p256dh: "p", auth: "a" },
      }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});

test("POST /api/push/subscribe returns 400 on invalid payload (endpoint not URL)", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  await seedTenant(prisma);
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "veridian_demo",
        endpoint: "not-a-url",
        keys: { p256dh: "p", auth: "a" },
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "invalid_payload");
  } finally {
    await close();
  }
});

test("POST /api/push/subscribe returns 400 if keys missing", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  await seedTenant(prisma);
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "veridian_demo",
        endpoint: "https://fcm.googleapis.com/fcm/send/xyz",
        // keys: manquant
      }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
