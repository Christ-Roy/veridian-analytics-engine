/**
 * ════════════════════════════════════════════════════════════════════════════
 * unsubscribe.integration.test.ts — POST /api/push/unsubscribe contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Couvre `src/push/index.ts:unsubscribePushClient` + la route
 * `POST /api/push/unsubscribe`.
 *
 * Le point que le fake ne prouve pas : l'`UPDATE ... SET active = false`
 * doit RÉELLEMENT atteindre Postgres. On vérifie en relisant la row.
 *
 * Isolation cross-fichier : pas de `resetDb()` (TRUNCATE global qui casse les
 * autres fichiers parallèles) — chaque test seede son tenant via
 * `seedTenantUnique` (cf `_seed.ts`, colonnes `@unique` randomisées pour
 * éviter la collision cross-process) + ses endpoints uniques (`randomUUID`),
 * et n'assert que sur ses propres rows.
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

const KEYS = { p256dh: "BPp256dh-unsub", auth: "auth-unsub" };

function uniqueEndpoint(label: string): string {
  return `https://fcm.googleapis.com/fcm/send/unsub-${label}-${randomUUID()}`;
}

function postUnsubscribe(endpoint: string) {
  return fetch(`${h.url}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

// ─── 1. Unsubscribe passe active=false RÉELLEMENT en DB ──────────────────────

test("unsubscribe: une sub active passe active=false en Postgres", async () => {
  const tenant = await seedTenantUnique(h.prisma, "unsub-active");
  const endpoint = uniqueEndpoint("active");

  const created = await h.prisma.pushSubscription.create({
    data: { tenantId: tenant.id, endpoint, keys: KEYS, active: true },
  });
  assert.equal(created.active, true);

  const res = await postUnsubscribe(endpoint);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; updated: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.updated, true);

  // Relire indépendamment : la colonne `active` doit valoir false en DB.
  const row = await h.prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  assert.ok(row, "la row existe toujours (unsubscribe ne supprime pas)");
  assert.equal(row.active, false, "active doit être false en Postgres");
  assert.equal(row.id, created.id, "même row, pas un INSERT");
});

// ─── 2. Unsubscribe d'un endpoint inconnu → no-op, pas d'erreur ──────────────

test("unsubscribe: endpoint inconnu → updated=false, pas d'erreur", async () => {
  const endpoint = uniqueEndpoint("never-subscribed");
  const res = await postUnsubscribe(endpoint);
  assert.equal(res.status, 200, "endpoint inconnu n'est pas une erreur");
  const body = (await res.json()) as { ok: boolean; updated: boolean };
  assert.equal(body.ok, true);
  assert.equal(body.updated, false);
  // L'endpoint n'a jamais existé en DB.
  assert.equal(
    await h.prisma.pushSubscription.findUnique({ where: { endpoint } }),
    null,
  );
});

// ─── 3. Unsubscribe deux fois → idempotent (reste active=false) ──────────────

test("unsubscribe: appelé deux fois → reste active=false, idempotent", async () => {
  const tenant = await seedTenantUnique(h.prisma, "unsub-idem");
  const endpoint = uniqueEndpoint("idem");
  await h.prisma.pushSubscription.create({
    data: { tenantId: tenant.id, endpoint, keys: KEYS, active: true },
  });

  const first = await postUnsubscribe(endpoint);
  assert.equal(((await first.json()) as { updated: boolean }).updated, true);

  const second = await postUnsubscribe(endpoint);
  assert.equal(second.status, 200);
  // 2e appel : la sub est déjà connue → update() la repasse à false (no-op
  // métier). updated reste true car la row existe.
  assert.equal(((await second.json()) as { updated: boolean }).updated, true);

  const row = await h.prisma.pushSubscription.findUnique({
    where: { endpoint },
  });
  assert.ok(row);
  assert.equal(row.active, false);
});

// ─── 4. Unsubscribe ne touche QUE l'endpoint ciblé ──────────────────────────

test("unsubscribe: ne désactive QUE la sub ciblée, pas les autres du tenant", async () => {
  const tenant = await seedTenantUnique(h.prisma, "unsub-scope");
  const target = uniqueEndpoint("target");
  const other = uniqueEndpoint("other");

  await h.prisma.pushSubscription.create({
    data: { tenantId: tenant.id, endpoint: target, keys: KEYS },
  });
  await h.prisma.pushSubscription.create({
    data: { tenantId: tenant.id, endpoint: other, keys: KEYS },
  });

  await postUnsubscribe(target);

  const targetRow = await h.prisma.pushSubscription.findUnique({
    where: { endpoint: target },
  });
  const otherRow = await h.prisma.pushSubscription.findUnique({
    where: { endpoint: other },
  });
  assert.equal(targetRow?.active, false, "la sub ciblée est désactivée");
  assert.equal(otherRow?.active, true, "l'autre sub du tenant reste active");
});

// ─── 5. Payload invalide → 400 ──────────────────────────────────────────────

test("unsubscribe: endpoint non-URL → 400 invalid_payload", async () => {
  const res = await fetch(`${h.url}/api/push/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: "garbage" }),
  });
  assert.equal(res.status, 400);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "invalid_payload",
  );
});
