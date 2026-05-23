/**
 * Tests unsubscribe — POST /api/push/unsubscribe + lib unsubscribePushClient.
 *
 * Couvre :
 *   - happy path : sub existante → active=false
 *   - endpoint inconnu → 200 ok+updated=false (pas d'erreur)
 *   - payload invalide → 400
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerPushRoutes } from "../../src/push/routes.js";
import {
  unsubscribePushClient,
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
  registerPushRoutes(app, {
    prisma: prisma as unknown as import("@prisma/client").PrismaClient,
    requireAdmin,
  });
  return app;
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

async function seedSub(prisma: FakePrismaClient, endpoint: string) {
  await prisma.tenant.create({
    data: {
      id: "tenant_t1",
      workspaceId: "veridian_demo",
      slug: "demo",
      name: "Demo",
    },
  });
  await prisma.pushSubscription.create({
    data: {
      tenantId: "tenant_t1",
      endpoint,
      keys: { p256dh: "p", auth: "a" },
    },
  });
}

test("unsubscribePushClient flips active=false on known endpoint", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const endpoint = "https://fcm.googleapis.com/fcm/send/known";
  await seedSub(prisma, endpoint);

  assert.equal(prisma.pushSubs[0].active, true);

  const r = await unsubscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    endpoint,
  );
  assert.equal(r.updated, true);
  assert.equal(prisma.pushSubs[0].active, false);
});

test("unsubscribePushClient returns updated=false on unknown endpoint", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();

  const r = await unsubscribePushClient(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "https://fcm.googleapis.com/fcm/send/ghost",
  );
  assert.equal(r.updated, false);
  assert.equal(prisma.pushSubs.length, 0);
});

test("POST /api/push/unsubscribe → 200 ok=true updated=true", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const endpoint = "https://fcm.googleapis.com/fcm/send/xyz";
  await seedSub(prisma, endpoint);
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; updated: boolean };
    assert.equal(body.ok, true);
    assert.equal(body.updated, true);
    assert.equal(prisma.pushSubs[0].active, false);
  } finally {
    await close();
  }
});

test("POST /api/push/unsubscribe with unknown endpoint → 200 ok=true updated=false", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://fcm.googleapis.com/fcm/send/ghost",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; updated: boolean };
    assert.equal(body.updated, false);
  } finally {
    await close();
  }
});

test("POST /api/push/unsubscribe with invalid payload → 400", async () => {
  _resetForTests();
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/push/unsubscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "not-a-url" }),
    });
    assert.equal(res.status, 400);
  } finally {
    await close();
  }
});
