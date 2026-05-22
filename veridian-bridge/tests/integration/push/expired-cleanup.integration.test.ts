/**
 * ════════════════════════════════════════════════════════════════════════════
 * expired-cleanup.integration.test.ts — cleanup auto 410 Gone contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Quand le push provider (FCM / Mozilla autopush) répond 410 Gone, le browser
 * a désinstallé la PWA : la PushSubscription est morte. `sendNotificationToTenant`
 * doit alors passer cette sub `active = false` pour ne plus jamais la ré-essayer.
 *
 * Le fake (`FakePrismaClient`) simule `updateMany` en mémoire — il ne prouve
 * pas que l'UPDATE atteint Postgres. Ici, après l'envoi, on relit chaque row
 * directement depuis la DB pour vérifier l'état `active`.
 *
 * Le seul appel réseau mocké est le push provider (`PushSender`), via
 * `setPushSenderForTests` : c'est le service tiers Google/Mozilla, pas notre code.
 *
 * Isolation cross-fichier : pas de `resetDb()` (TRUNCATE global qui casserait
 * les fichiers parallèles). Chaque test seede son tenant unique et n'assert
 * que sur les rows de CE tenant.
 */

import { test, before, after, beforeEach } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  sendNotificationToTenant,
  setPushSenderForTests,
  type PushSender,
} from "../../../src/push/index.js";
import {
  bootBridgeWithRealDB,
  type BridgeHarness,
} from "../_harness/index.js";
import { seedTenantUnique } from "./_seed.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  setPushSenderForTests(null);
  await h.close();
});

beforeEach(() => {
  setPushSenderForTests(null);
});

const KEYS = { p256dh: "BPp256dh-cleanup", auth: "auth-cleanup" };

/** Crée une PushSubscription active réelle, retourne son id. */
async function seedSub(tenantId: string, tag: string): Promise<string> {
  const row = await h.prisma.pushSubscription.create({
    data: {
      tenantId,
      endpoint: `https://fcm.googleapis.com/fcm/send/cl-${tag}-${randomUUID()}`,
      keys: KEYS,
      active: true,
    },
  });
  return row.id;
}

// ─── 1. 410 Gone → la sub passe RÉELLEMENT active=false en DB ────────────────

test("cleanup: web-push 410 Gone → la sub passe active=false en Postgres", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cleanup-g410");
  const goneId = await seedSub(tenant.id, "gone");

  // Le provider répond 410 : la subscription est morte côté browser.
  setPushSenderForTests(async () => ({ statusCode: 410 }));

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Cleanup",
    body: "Cette sub est morte",
  });

  assert.equal(result.targetCount, 1);
  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 1);
  assert.equal(result.cleanedCount, 1, "410 → 1 sub nettoyée");

  // LA preuve : relire la row depuis Postgres, `active` doit être false.
  const row = await h.prisma.pushSubscription.findUnique({
    where: { id: goneId },
  });
  assert.ok(row, "la row n'est pas supprimée, juste désactivée");
  assert.equal(row.active, false, "la sub 410 doit être active=false en DB");
});

// ─── 2. 404 Not Found → même cleanup que 410 ────────────────────────────────

test("cleanup: web-push 404 → la sub passe aussi active=false en Postgres", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cleanup-g404");
  const id = await seedSub(tenant.id, "notfound");
  setPushSenderForTests(async () => ({ statusCode: 404 }));

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Cleanup 404",
    body: "Endpoint introuvable",
  });
  assert.equal(result.cleanedCount, 1);

  const row = await h.prisma.pushSubscription.findUnique({ where: { id } });
  assert.equal(row?.active, false);
});

// ─── 3. Mix : seules les subs 410 sont nettoyées, les saines restent actives ─

test("cleanup: mix 201/410/500 → seules les 410 désactivées, le reste intact", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cleanup-mix");
  const okId = await seedSub(tenant.id, "mix-ok");
  const goneId = await seedSub(tenant.id, "mix-gone");
  const errId = await seedSub(tenant.id, "mix-err");

  const sender: PushSender = async (sub) => {
    if (sub.endpoint.includes("mix-ok")) return { statusCode: 201 };
    if (sub.endpoint.includes("mix-gone")) return { statusCode: 410 };
    return { statusCode: 500 }; // erreur transitoire — PAS un cleanup
  };
  setPushSenderForTests(sender);

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Mix cleanup",
    body: "Un sain, un mort, un en erreur",
  });

  assert.equal(result.targetCount, 3);
  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 2);
  assert.equal(result.cleanedCount, 1, "seul le 410 compte comme nettoyé");

  // Relecture indépendante de chaque row.
  const okRow = await h.prisma.pushSubscription.findUnique({
    where: { id: okId },
  });
  const goneRow = await h.prisma.pushSubscription.findUnique({
    where: { id: goneId },
  });
  const errRow = await h.prisma.pushSubscription.findUnique({
    where: { id: errId },
  });
  assert.equal(okRow?.active, true, "la sub 201 reste active");
  assert.equal(goneRow?.active, false, "la sub 410 est désactivée");
  assert.equal(
    errRow?.active,
    true,
    "la sub 500 reste active (erreur transitoire, retry plus tard)",
  );
});

// ─── 4. Plusieurs 410 d'un coup → updateMany atteint toutes les rows ────────

test("cleanup: plusieurs 410 → updateMany désactive toutes les subs mortes", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cleanup-bulk");
  for (let i = 0; i < 5; i++) {
    await seedSub(tenant.id, `bulk-${i}`);
  }
  setPushSenderForTests(async () => ({ statusCode: 410 }));

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Bulk cleanup",
    body: "Toutes mortes",
  });
  assert.equal(result.cleanedCount, 5);

  const activeLeft = await h.prisma.pushSubscription.count({
    where: { tenantId: tenant.id, active: true },
  });
  assert.equal(activeLeft, 0, "les 5 subs 410 doivent toutes être désactivées");
});

// ─── 5. Une sub nettoyée n'est plus ciblée au prochain envoi ────────────────

test("cleanup: une sub 410 nettoyée est exclue du prochain broadcast", async () => {
  const tenant = await seedTenantUnique(h.prisma, "cleanup-next");
  await seedSub(tenant.id, "next-gone");
  await seedSub(tenant.id, "next-ok");

  // 1er envoi : la sub "gone" répond 410 → nettoyée.
  setPushSenderForTests(async (sub) =>
    sub.endpoint.includes("next-gone")
      ? { statusCode: 410 }
      : { statusCode: 201 },
  );
  const first = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Premier",
    body: "Un mort détecté",
  });
  assert.equal(first.targetCount, 2);
  assert.equal(first.cleanedCount, 1);

  // 2e envoi : la sub morte ne doit plus être dans la cible.
  setPushSenderForTests(async () => ({ statusCode: 201 }));
  const second = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Second",
    body: "Plus que la sub saine",
  });
  assert.equal(
    second.targetCount,
    1,
    "la sub nettoyée au 1er envoi est exclue du 2e",
  );
  assert.equal(second.successCount, 1);
});
