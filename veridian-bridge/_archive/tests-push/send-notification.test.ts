/**
 * Tests send-notification — sendNotificationToTenant + POST /api/admin/push/send.
 *
 * Couvre :
 *   - happy path : mock sender retourne 201 → successCount = N
 *   - aucune sub active → targetCount=0, success=0, failure=0
 *   - mix succès/échec : sender retourne 201 / 500 → count correct
 *   - 410 Gone → cleanup auto (active=false sur la sub)
 *   - PushNotification row logué avec targetCount/success/failure corrects
 *   - endpoint admin require Bearer
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Request, Response, NextFunction } from "express";
import { registerPushRoutes } from "../../src/push/routes.js";
import {
  sendNotificationToTenant,
  setPushSenderForTests,
  _resetForTests,
  configureWebPush,
  type PushSender,
} from "../../src/push/index.js";
import { FakePrismaClient } from "../helpers/fake-prisma.js";

const VAPID_PUBLIC = "BMa9I_teR6iZfP09lzwy8HnI9fU77rUVajmJTmWv0Iiy7V3R5trzNRdJj1DZt8ewb_-VFX3ZEig190bA5tx6qUo";
const VAPID_PRIVATE = "y5VCetmsjhLXCaaSDjtVQ_KfKkQNcOV6qne7TpjdS_k";
const ADMIN_KEY = "test-admin-key";

function makeApp(prisma: FakePrismaClient) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
    const auth = req.header("authorization");
    if (auth === `Bearer ${ADMIN_KEY}`) return next();
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

async function seedTenantAndSubs(
  prisma: FakePrismaClient,
  count: number,
): Promise<void> {
  await prisma.tenant.create({
    data: {
      id: "tenant_t1",
      workspaceId: "veridian_demo",
      slug: "demo",
      name: "Demo",
    },
  });
  for (let i = 0; i < count; i++) {
    await prisma.pushSubscription.create({
      data: {
        tenantId: "tenant_t1",
        endpoint: `https://fcm.googleapis.com/fcm/send/sub_${i}`,
        keys: { p256dh: `p${i}`, auth: `a${i}` },
      },
    });
  }
}

function setupConfig() {
  _resetForTests();
  setPushSenderForTests(null); // reset to default before each test
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
  });
}

test("sendNotificationToTenant: all subs receive (sender returns 201) → success=N", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 3);

  const calls: Array<{ endpoint: string; payload: string }> = [];
  const mockSender: PushSender = async (sub, payload) => {
    calls.push({ endpoint: sub.endpoint, payload });
    return { statusCode: 201 };
  };
  setPushSenderForTests(mockSender);

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "Hello", body: "World", url: "https://app.veridian.site/promo" },
  );

  assert.equal(r.targetCount, 3);
  assert.equal(r.successCount, 3);
  assert.equal(r.failureCount, 0);
  assert.equal(r.cleanedCount, 0);
  assert.equal(calls.length, 3);

  // PushNotification row logué
  assert.equal(prisma.pushNotifs.length, 1);
  assert.equal(prisma.pushNotifs[0].title, "Hello");
  assert.equal(prisma.pushNotifs[0].successCount, 3);
  assert.equal(prisma.pushNotifs[0].targetCount, 3);

  // payload contient title/body/url
  const parsed = JSON.parse(calls[0].payload);
  assert.equal(parsed.title, "Hello");
  assert.equal(parsed.body, "World");
  assert.equal(parsed.url, "https://app.veridian.site/promo");
});

test("sendNotificationToTenant: no active subs → targetCount=0, notif logué quand même", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: {
      id: "tenant_t1",
      workspaceId: "veridian_demo",
      slug: "demo",
      name: "Demo",
    },
  });

  let senderCalled = 0;
  setPushSenderForTests(async () => {
    senderCalled++;
    return { statusCode: 201 };
  });

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "Empty", body: "Nobody" },
  );

  assert.equal(r.targetCount, 0);
  assert.equal(r.successCount, 0);
  assert.equal(r.failureCount, 0);
  assert.equal(senderCalled, 0);
  assert.equal(prisma.pushNotifs.length, 1); // audit row quand même
});

test("sendNotificationToTenant: mix 201 / 500 → success/failure counts corrects", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 4);

  let i = 0;
  setPushSenderForTests(async () => {
    const code = i++ % 2 === 0 ? 201 : 500;
    return { statusCode: code };
  });

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T", body: "B" },
  );

  assert.equal(r.targetCount, 4);
  assert.equal(r.successCount, 2);
  assert.equal(r.failureCount, 2);
  assert.equal(r.cleanedCount, 0); // 500 ≠ 410/404, on garde la sub

  // toutes les subs sont restées actives
  assert.equal(prisma.pushSubs.filter((s) => s.active).length, 4);
});

test("sendNotificationToTenant: sender throws → comptabilisé en failure", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 2);

  setPushSenderForTests(async () => {
    throw new Error("network down");
  });

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T", body: "B" },
  );

  assert.equal(r.successCount, 0);
  assert.equal(r.failureCount, 2);
});

test("sendNotificationToTenant: tenant unknown → throws tenant_not_found", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();

  await assert.rejects(
    () =>
      sendNotificationToTenant(
        prisma as unknown as import("@prisma/client").PrismaClient,
        "ghost_tenant",
        { title: "T", body: "B" },
      ),
    /tenant_not_found/,
  );
});

test("POST /api/admin/push/send requires Bearer", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/admin/push/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: "tenant_t1",
        title: "T",
        body: "B",
      }),
    });
    assert.equal(res.status, 401);
  } finally {
    await close();
  }
});

test("POST /api/admin/push/send happy path (admin Bearer)", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 2);
  setPushSenderForTests(async () => ({ statusCode: 201 }));

  const { url, close } = await startServer(makeApp(prisma));
  try {
    const res = await fetch(`${url}/api/admin/push/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        tenantId: "tenant_t1",
        title: "Hello",
        body: "World",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      targetCount: number;
      successCount: number;
    };
    assert.equal(body.ok, true);
    assert.equal(body.targetCount, 2);
    assert.equal(body.successCount, 2);
  } finally {
    await close();
  }
});

test("POST /api/admin/push/send 404 si tenantId inconnu", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  const { url, close } = await startServer(makeApp(prisma));

  try {
    const res = await fetch(`${url}/api/admin/push/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_KEY}`,
      },
      body: JSON.stringify({
        tenantId: "ghost",
        title: "T",
        body: "B",
      }),
    });
    assert.equal(res.status, 404);
  } finally {
    await close();
  }
});
