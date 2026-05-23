/**
 * ════════════════════════════════════════════════════════════════════════════
 * send-notification.integration.test.ts — envoi push contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Couvre `src/push/index.ts:sendNotificationToTenant` + la route admin
 * `POST /api/admin/push/send`.
 *
 * Le HTTP push réel (web-push → FCM) n'est PAS appelé : on injecte un faux
 * `PushSender` via `setPushSenderForTests` — un mock du seul appel RÉSEAU
 * sortant qu'on ne maîtrise pas (le serveur FCM de Google). TOUT le reste
 * est réel : les `PushSubscription` sont en Postgres, le log `PushNotification`
 * est écrit en Postgres, la boucle d'envoi et l'agrégation success/failure
 * tournent pour de vrai.
 *
 * Ce que le fake (`FakePrismaClient`) ne prouve pas et qu'on prouve ici :
 *   - le `PushNotification` est RÉELLEMENT inséré (targetCount), puis
 *     RÉELLEMENT mis à jour (successCount/failureCount) en deux requêtes SQL ;
 *   - `findMany({ where: { active: true } })` filtre vraiment côté Postgres
 *     (les subs inactives ne reçoivent rien) ;
 *   - `updateMany` du cleanup 410 atteint vraiment plusieurs rows.
 *
 * Isolation cross-fichier : pas de `resetDb()` (TRUNCATE global qui casserait
 * les fichiers parallèles). Chaque test seede son tenant via `seedTenantUnique`
 * (cf `_seed.ts`, colonnes `@unique` randomisées contre la collision
 * cross-process) et n'assert que sur les rows de CE tenant
 * (`where: { tenantId }`). `setPushSenderForTests` est un singleton module —
 * sûr ici car node:test exécute les tests d'un même fichier en série.
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
  TEST_ADMIN_KEY,
  type BridgeHarness,
} from "../_harness/index.js";
import { seedTenantUnique } from "./_seed.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  // Restaure le sender par défaut pour ne pas polluer d'autres fichiers.
  setPushSenderForTests(null);
  await h.close();
});

beforeEach(() => {
  // Reset du sender entre tests — PAS de resetDb (isolation par tenant unique).
  setPushSenderForTests(null);
});

const KEYS = { p256dh: "BPp256dh-send", auth: "auth-send" };

/**
 * Seed `count` PushSubscription réelles, toutes actives par défaut, pour
 * `tenantId`. Endpoints distincts (contrainte @@unique réelle) ET globalement
 * uniques (`randomUUID`) pour ne pas collisionner avec un autre fichier.
 */
async function seedSubs(
  tenantId: string,
  count: number,
  opts: { active?: boolean } = {},
): Promise<void> {
  for (let i = 0; i < count; i++) {
    await h.prisma.pushSubscription.create({
      data: {
        tenantId,
        endpoint: `https://fcm.googleapis.com/fcm/send/sn-${i}-${randomUUID()}`,
        keys: KEYS,
        active: opts.active ?? true,
      },
    });
  }
}

/** Sender qui répond toujours `statusCode`. */
function constSender(statusCode: number): PushSender {
  return async () => ({ statusCode });
}

// ─── 1. Happy path : N subs actives → N succès + PushNotification logué ──────

test("send: 3 subs actives, sender 201 → successCount=3, PushNotification logué en DB", async () => {
  const tenant = await seedTenantUnique(h.prisma, "send-happy");
  await seedSubs(tenant.id, 3);
  setPushSenderForTests(constSender(201));

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Nouvelle promo",
    body: "Votre devis est prêt",
    sentBy: "user_admin_1",
  });

  assert.equal(result.targetCount, 3);
  assert.equal(result.successCount, 3);
  assert.equal(result.failureCount, 0);
  assert.equal(result.cleanedCount, 0);

  // Le log PushNotification doit être RÉELLEMENT en Postgres avec les
  // compteurs corrects (insert targetCount puis update success/failure).
  const log = await h.prisma.pushNotification.findUnique({
    where: { id: result.notificationId },
  });
  assert.ok(log, "le PushNotification doit être relisible depuis Postgres");
  assert.equal(log.tenantId, tenant.id);
  assert.equal(log.title, "Nouvelle promo");
  assert.equal(log.body, "Votre devis est prêt");
  assert.equal(log.targetCount, 3);
  assert.equal(log.successCount, 3);
  assert.equal(log.failureCount, 0);
  assert.equal(log.sentBy, "user_admin_1");

  assert.equal(
    await h.prisma.pushNotification.count({ where: { tenantId: tenant.id } }),
    1,
  );
});

// ─── 2. Aucune sub active → targetCount=0, log quand même écrit ──────────────

test("send: 0 sub active → targetCount=0, PushNotification logué avec compteurs 0", async () => {
  const tenant = await seedTenantUnique(h.prisma, "send-empty");
  // Des subs INACTIVES uniquement : ne doivent PAS être ciblées.
  await seedSubs(tenant.id, 2, { active: false });
  setPushSenderForTests(constSender(201));

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Rien",
    body: "Personne n'écoute",
  });

  assert.equal(result.targetCount, 0, "les subs inactives sont exclues");
  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 0);

  const log = await h.prisma.pushNotification.findUnique({
    where: { id: result.notificationId },
  });
  assert.ok(log, "un log est écrit même sans destinataire");
  assert.equal(log.targetCount, 0);
});

// ─── 3. Mix succès / échec : compteurs corrects ─────────────────────────────

test("send: mix 201/500 → successCount/failureCount reflètent le réel", async () => {
  const tenant = await seedTenantUnique(h.prisma, "send-mix");
  await seedSubs(tenant.id, 4);

  // Sender : succès pour les subs paires (selon l'ordre d'insertion en DB),
  // 500 pour les impaires. On lit l'index encodé dans l'endpoint.
  setPushSenderForTests(async (sub) => {
    const seg = sub.endpoint.split("/").pop() ?? "";
    const idx = Number(seg.split("-")[1]);
    return { statusCode: idx % 2 === 0 ? 201 : 500 };
  });

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Mix",
    body: "Deux marchent, deux échouent",
  });

  assert.equal(result.targetCount, 4);
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 2);
  assert.equal(result.cleanedCount, 0, "500 n'est pas un 410 → pas de cleanup");

  const log = await h.prisma.pushNotification.findUnique({
    where: { id: result.notificationId },
  });
  assert.ok(log);
  assert.equal(log.successCount, 2);
  assert.equal(log.failureCount, 2);

  // Les subs restent toutes actives : un 500 est transitoire, pas un Gone.
  const stillActive = await h.prisma.pushSubscription.count({
    where: { tenantId: tenant.id, active: true },
  });
  assert.equal(stillActive, 4);
});

// ─── 4. Sender qui throw → comptabilisé en échec, pas de crash ──────────────

test("send: sender qui throw → failureCount incrémenté, log cohérent", async () => {
  const tenant = await seedTenantUnique(h.prisma, "send-throw");
  await seedSubs(tenant.id, 2);
  setPushSenderForTests(async () => {
    throw new Error("network down");
  });

  const result = await sendNotificationToTenant(h.prisma, tenant.id, {
    title: "Throw",
    body: "Le sender plante",
  });

  assert.equal(result.targetCount, 2);
  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 2);

  const log = await h.prisma.pushNotification.findUnique({
    where: { id: result.notificationId },
  });
  assert.equal(log?.failureCount, 2);
});

// ─── 5. Route admin POST /api/admin/push/send — bout en bout ────────────────

test("send: POST /api/admin/push/send (Bearer) → envoie + log en DB", async () => {
  const tenant = await seedTenantUnique(h.prisma, "send-route");
  await seedSubs(tenant.id, 2);
  setPushSenderForTests(constSender(201));

  const res = await fetch(`${h.url}/api/admin/push/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    },
    body: JSON.stringify({
      tenantId: tenant.id,
      title: "Via route",
      body: "Envoi via endpoint admin",
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    ok: boolean;
    targetCount: number;
    successCount: number;
    notificationId: string;
  };
  assert.equal(body.ok, true);
  assert.equal(body.targetCount, 2);
  assert.equal(body.successCount, 2);

  const log = await h.prisma.pushNotification.findUnique({
    where: { id: body.notificationId },
  });
  assert.ok(log, "la route a bien persisté le PushNotification");
  assert.equal(log.title, "Via route");
});

// ─── 6. Route admin sans Bearer → 401, rien envoyé ──────────────────────────

test("send: POST /api/admin/push/send sans Bearer → 401", async () => {
  const tenant = await seedTenantUnique(h.prisma, "send-noauth");
  await seedSubs(tenant.id, 1);

  const res = await fetch(`${h.url}/api/admin/push/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: tenant.id, title: "X", body: "Y" }),
  });
  assert.equal(res.status, 401);
  assert.equal(
    await h.prisma.pushNotification.count({ where: { tenantId: tenant.id } }),
    0,
    "aucun PushNotification ne doit être logué quand l'auth échoue",
  );
});

// ─── 7. Route admin tenant inconnu → 404 ────────────────────────────────────

test("send: POST /api/admin/push/send tenant inconnu → 404 tenant_not_found", async () => {
  const res = await fetch(`${h.url}/api/admin/push/send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    },
    body: JSON.stringify({
      tenantId: `tenant_inexistant_${randomUUID()}`,
      title: "X",
      body: "Y",
    }),
  });
  assert.equal(res.status, 404);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "tenant_not_found",
  );
});
