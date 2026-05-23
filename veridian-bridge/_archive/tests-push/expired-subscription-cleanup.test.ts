/**
 * Tests cleanup auto sur 410 Gone / 404 — sub marquée active=false.
 *
 * Couvre :
 *   - sender retourne 410 → sub.active=false dans la DB
 *   - sender retourne 404 → sub.active=false dans la DB
 *   - sender retourne 500 → sub reste active=true (erreur transitoire)
 *   - mix 201/410/410 → cleanedCount=2, success=1
 *   - prochain send n'envoie plus aux subs cleanées (active=false)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
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

function setupConfig() {
  _resetForTests();
  setPushSenderForTests(null);
  configureWebPush({
    publicKey: VAPID_PUBLIC,
    privateKey: VAPID_PRIVATE,
    subject: "mailto:test@veridian.site",
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

test("sender retourne 410 → sub.active devient false", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 1);

  setPushSenderForTests(async () => ({ statusCode: 410 }));

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T", body: "B" },
  );

  assert.equal(r.successCount, 0);
  assert.equal(r.failureCount, 1);
  assert.equal(r.cleanedCount, 1);
  assert.equal(prisma.pushSubs[0].active, false);
});

test("sender retourne 404 → sub.active devient false", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 1);

  setPushSenderForTests(async () => ({ statusCode: 404 }));

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T", body: "B" },
  );

  assert.equal(r.cleanedCount, 1);
  assert.equal(prisma.pushSubs[0].active, false);
});

test("sender retourne 500 → sub reste active=true (erreur transitoire)", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 1);

  setPushSenderForTests(async () => ({ statusCode: 500 }));

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T", body: "B" },
  );

  assert.equal(r.failureCount, 1);
  assert.equal(r.cleanedCount, 0);
  assert.equal(prisma.pushSubs[0].active, true);
});

test("mix 201/410/410 sur 3 subs → cleanedCount=2 / successCount=1", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 3);

  let i = 0;
  const codes = [201, 410, 410];
  const sender: PushSender = async () => ({ statusCode: codes[i++] ?? 500 });
  setPushSenderForTests(sender);

  const r = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T", body: "B" },
  );

  assert.equal(r.successCount, 1);
  assert.equal(r.failureCount, 2);
  assert.equal(r.cleanedCount, 2);
  const activeCount = prisma.pushSubs.filter((s) => s.active).length;
  assert.equal(activeCount, 1);
});

test("après cleanup, prochain send ne touche plus les subs inactives", async () => {
  setupConfig();
  const prisma = new FakePrismaClient();
  await seedTenantAndSubs(prisma, 2);

  // 1er envoi : la première sub renvoie 410 → cleanup
  let firstCall = true;
  setPushSenderForTests(async () => {
    if (firstCall) {
      firstCall = false;
      return { statusCode: 410 };
    }
    return { statusCode: 201 };
  });
  await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T1", body: "B1" },
  );
  // 1 sub désactivée
  assert.equal(prisma.pushSubs.filter((s) => s.active).length, 1);

  // 2e envoi : on log les endpoints touchés. La sub désactivée NE doit
  // PAS recevoir.
  const touched: string[] = [];
  setPushSenderForTests(async (sub) => {
    touched.push(sub.endpoint);
    return { statusCode: 201 };
  });
  const r2 = await sendNotificationToTenant(
    prisma as unknown as import("@prisma/client").PrismaClient,
    "tenant_t1",
    { title: "T2", body: "B2" },
  );

  assert.equal(r2.targetCount, 1);
  assert.equal(touched.length, 1);
  // L'endpoint touché est celui resté actif
  const stillActive = prisma.pushSubs.find((s) => s.active)!;
  assert.equal(touched[0], stillActive.endpoint);
});
