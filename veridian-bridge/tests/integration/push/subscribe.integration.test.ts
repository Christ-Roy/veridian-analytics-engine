/**
 * ════════════════════════════════════════════════════════════════════════════
 * subscribe.integration.test.ts — POST /api/push/subscribe contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Couvre `src/push/index.ts:subscribePushClient` + la route
 * `POST /api/push/subscribe` (src/push/routes.ts) avec une vraie row
 * `PushSubscription` en Postgres.
 *
 * Ce que le fake (`FakePrismaClient`) ne prouve PAS et qu'on prouve ici :
 *   - la contrainte `@@unique` réelle sur `PushSubscription.endpoint` ;
 *   - le re-subscribe idempotent qui passe par un vrai `findUnique` +
 *     `update` (pas une simulation in-memory) ;
 *   - la ré-attribution d'un endpoint à un autre tenant ne crée PAS de
 *     doublon (sinon Postgres lèverait P2002).
 *
 * ─── Isolation cross-fichier ────────────────────────────────────────────────
 *
 * `node --test` exécute les `*.integration.test.ts` EN PARALLÈLE (un PROCESS
 * par CPU) sur le MÊME Postgres de test. Deux conséquences gérées ici :
 *   1. `resetDb()` est un TRUNCATE global → on ne l'appelle JAMAIS (il
 *      viderait les données d'un autre fichier en cours).
 *   2. `seedTenant()` du harness génère ses valeurs uniques via un compteur
 *      de MODULE → collision cross-process sur `slug`/`hubTenantId`/`apiKey`.
 *      On passe par `seedTenantUnique()` (cf `_seed.ts`) qui randomise toutes
 *      les colonnes `@unique`.
 * Toutes les assertions de comptage sont SCOPÉES (`where: { tenantId }`).
 * Le passage du runner en `--test-concurrency=1` est suivi dans un ticket
 * todo/ (zone socle T1).
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
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
  await h.close();
});

// ─── Helpers ────────────────────────────────────────────────────────────────

interface SubscribeBody {
  workspaceId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  siteId?: string;
  userAgent?: string;
  visitorId?: string;
}

function postSubscribe(body: SubscribeBody) {
  return fetch(`${h.url}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Endpoint push unique (la colonne `endpoint` est @@unique en DB). */
function uniqueEndpoint(label: string): string {
  return `https://fcm.googleapis.com/fcm/send/${label}-${randomUUID()}`;
}

const KEYS = { p256dh: "BPp256dh-public-key", auth: "auth-secret-tok" };

// ─── 1. Subscribe écrit RÉELLEMENT une PushSubscription en Postgres ──────────

test("subscribe: POST /api/push/subscribe persiste une PushSubscription en DB", async () => {
  const tenant = await seedTenantUnique(h.prisma, "persist");
  const endpoint = uniqueEndpoint("persist");

  const res = await postSubscribe({
    workspaceId: tenant.workspaceId,
    endpoint,
    keys: KEYS,
    userAgent: "Mozilla/5.0 (integration)",
    visitorId: "vrd_vid_abc",
  });

  assert.equal(res.status, 201, "première subscription → 201 created");
  const body = (await res.json()) as {
    ok: boolean;
    id: string;
    created: boolean;
  };
  assert.equal(body.ok, true);
  assert.equal(body.created, true);

  // Relire indépendamment depuis Postgres : prouve que c'est persisté.
  const row = await h.prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  assert.ok(row, "la PushSubscription doit être relisible depuis Postgres");
  assert.equal(row.id, body.id);
  assert.equal(row.tenantId, tenant.id);
  assert.equal(row.active, true, "default DB active=true respecté");
  assert.equal(row.userAgent, "Mozilla/5.0 (integration)");
  assert.equal(row.visitorId, "vrd_vid_abc");
  // keys est une colonne Json — on vérifie le round-trip.
  assert.deepEqual(row.keys, KEYS);

  // Scopé au tenant courant (count global = non déterministe en parallèle).
  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenant.id } }),
    1,
  );
});

// ─── 2. Re-subscribe même endpoint → idempotent (vraie contrainte @@unique) ──

test("subscribe: re-subscribe le MÊME endpoint → idempotent, pas de doublon", async () => {
  const tenant = await seedTenantUnique(h.prisma, "idem");
  const endpoint = uniqueEndpoint("idem");

  // 1er appel → INSERT.
  const first = await postSubscribe({
    workspaceId: tenant.workspaceId,
    endpoint,
    keys: { p256dh: "old-p256dh", auth: "old-auth" },
  });
  assert.equal(first.status, 201);
  const firstBody = (await first.json()) as { id: string; created: boolean };
  assert.equal(firstBody.created, true);

  // 2e appel, MÊME endpoint, keys mises à jour → UPDATE, pas INSERT.
  // Si le code faisait un create() naïf, la contrainte unique sur `endpoint`
  // lèverait P2002. L'idempotence est donc prouvée par Postgres lui-même.
  const second = await postSubscribe({
    workspaceId: tenant.workspaceId,
    endpoint,
    keys: { p256dh: "new-p256dh", auth: "new-auth" },
  });
  assert.equal(second.status, 200, "re-subscribe → 200 (pas 201)");
  const secondBody = (await second.json()) as { id: string; created: boolean };
  assert.equal(secondBody.created, false);
  assert.equal(secondBody.id, firstBody.id, "même row réutilisée");

  // Toujours UNE seule row pour ce tenant, avec les keys mises à jour.
  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenant.id } }),
    1,
    "la contrainte @@unique sur endpoint garantit zéro doublon",
  );
  const row = await h.prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  assert.ok(row);
  assert.deepEqual(row.keys, { p256dh: "new-p256dh", auth: "new-auth" });
});

// ─── 3. Re-subscribe d'un endpoint réactive une sub désactivée ──────────────

test("subscribe: re-subscribe réactive une sub passée active=false", async () => {
  const tenant = await seedTenantUnique(h.prisma, "react");
  const endpoint = uniqueEndpoint("react");

  // Sub désactivée directement en DB (simule un cleanup 410 antérieur).
  await h.prisma.pushSubscription.create({
    data: { tenantId: tenant.id, endpoint, keys: KEYS, active: false },
  });

  const res = await postSubscribe({
    workspaceId: tenant.workspaceId,
    endpoint,
    keys: KEYS,
  });
  assert.equal(res.status, 200, "endpoint connu → update → 200");

  const row = await h.prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  assert.ok(row);
  assert.equal(row.active, true, "re-subscribe réactive la sub");
});

// ─── 4. Re-subscribe d'un endpoint réutilisé par un AUTRE tenant ────────────

test("subscribe: endpoint réutilisé par un autre tenant → ré-attribué sans doublon", async () => {
  const tenantA = await seedTenantUnique(h.prisma, "tA");
  const tenantB = await seedTenantUnique(h.prisma, "tB");
  const endpoint = uniqueEndpoint("shared");

  await postSubscribe({
    workspaceId: tenantA.workspaceId,
    endpoint,
    keys: KEYS,
  });
  await postSubscribe({
    workspaceId: tenantB.workspaceId,
    endpoint,
    keys: KEYS,
  });

  // L'endpoint est unique en DB : un seul row, ré-attribué au tenant B.
  const row = await h.prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  assert.ok(row);
  assert.equal(row.tenantId, tenantB.id, "endpoint ré-attribué au tenant B");
  // Le tenant A n'a plus aucune sub sur cet endpoint.
  assert.equal(
    await h.prisma.pushSubscription.count({ where: { tenantId: tenantA.id } }),
    0,
    "l'endpoint a quitté le tenant A",
  );
  assert.notEqual(tenantA.id, tenantB.id);
});

// ─── 5. workspaceId inconnu → 404, rien en DB ───────────────────────────────

test("subscribe: workspaceId inconnu → 404 tenant_not_found", async () => {
  const ghostWs = `ws_ghost_${randomUUID()}`;
  const endpoint = uniqueEndpoint("ghost");
  const res = await postSubscribe({
    workspaceId: ghostWs,
    endpoint,
    keys: KEYS,
  });
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "tenant_not_found");
  // Aucune row ne doit avoir été écrite pour cet endpoint.
  assert.equal(
    await h.prisma.pushSubscription.findUnique({ where: { endpoint } }),
    null,
  );
});

// ─── 6. Payload invalide → 400, rien en DB ──────────────────────────────────

test("subscribe: endpoint non-URL → 400 invalid_payload", async () => {
  const tenant = await seedTenantUnique(h.prisma, "badpayload");
  const res = await fetch(`${h.url}/api/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      workspaceId: tenant.workspaceId,
      endpoint: "not-a-url",
      keys: KEYS,
    }),
  });
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_payload");
});
