/**
 * ════════════════════════════════════════════════════════════════════════════
 * rate-limit.integration.test.ts — T3
 * ════════════════════════════════════════════════════════════════════════════
 *
 * `/api/ingest/form` est rate-limité 10 req/min/IP (sliding window in-memory).
 * La 11e requête depuis la même IP doit renvoyer 429 + header `Retry-After`.
 *
 * Le rate limiter est en mémoire (pas en DB) mais on teste ici contre le VRAI
 * bridge booté par le harness — même instance que la prod, vraie chaîne
 * Express. On force l'IP via `X-Forwarded-For` (cf `getClientIp`).
 *
 * On vérifie aussi que le rate limit ne bloque PAS l'ingest légitime : les 10
 * premières requêtes ont bien écrit en Postgres, la 11e n'a rien écrit.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  seedTenant,
  seedSite,
  type BridgeHarness,
} from "../_harness/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDb(h.prisma);
});

/** POST une soumission depuis une IP donnée (X-Forwarded-For). */
async function postFromIp(
  siteKey: string,
  ip: string,
  i: number,
): Promise<Response> {
  return fetch(`${h.url}/api/ingest/form`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify({
      siteKey,
      formSlug: "contact",
      data: { email: `visitor${i}@example.com` },
    }),
  });
}

// ─── 1. La 11e requête/min/IP → 429 ─────────────────────────────────────────

test("rate-limit: la 11e requête depuis la même IP → 429 rate_limited", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_rl" });

  const ip = "203.0.113.42";

  // Les 10 premières doivent passer (limite = 10/min).
  for (let i = 0; i < 10; i++) {
    const res = await postFromIp("pk_rl", ip, i);
    assert.equal(res.status, 200, `la requête #${i + 1} doit passer (200)`);
  }

  // La 11e doit être bloquée.
  const blocked = await postFromIp("pk_rl", ip, 99);
  assert.equal(blocked.status, 429, "la 11e requête doit être 429");
  const body = (await blocked.json()) as { error: string; retryAfterSec: number };
  assert.equal(body.error, "rate_limited");
  assert.equal(body.retryAfterSec, 60);
  assert.equal(
    blocked.headers.get("retry-after"),
    "60",
    "le header Retry-After doit être posé",
  );

  // ── Preuve Postgres : exactement 10 submissions écrites, pas 11 ──
  assert.equal(
    await h.prisma.formSubmission.count(),
    10,
    "la 11e requête bloquée ne doit RIEN avoir écrit en DB",
  );
});

// ─── 2. Le rate limit est PAR IP — une autre IP n'est pas affectée ──────────

test("rate-limit: une IP différente garde son quota intact", async () => {
  const tenant = await seedTenant(h.prisma);
  await seedSite(h.prisma, tenant.id, { siteKey: "pk_rl2" });

  // IP A épuise son quota.
  const ipA = "198.51.100.1";
  for (let i = 0; i < 10; i++) {
    await postFromIp("pk_rl2", ipA, i);
  }
  const blockedA = await postFromIp("pk_rl2", ipA, 99);
  assert.equal(blockedA.status, 429, "IP A doit être bloquée");

  // IP B n'a jamais posté → doit passer.
  const ipB = "198.51.100.2";
  const okB = await postFromIp("pk_rl2", ipB, 0);
  assert.equal(okB.status, 200, "IP B garde son quota — le limiter est par IP");

  // 10 (IP A) + 1 (IP B) = 11 submissions en DB.
  assert.equal(await h.prisma.formSubmission.count(), 11);
});
