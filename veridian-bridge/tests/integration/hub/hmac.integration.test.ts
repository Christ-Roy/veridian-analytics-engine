/**
 * ════════════════════════════════════════════════════════════════════════════
 * hmac.integration.test.ts — middleware HMAC Hub contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket T2. Couvre `src/hub-hmac.ts` (middleware HMAC sur `/api/tenants/*`).
 *
 * La valeur ajoutée vs les tests unitaires `tests/hub/hmac-*.test.ts` :
 *   - Les unitaires vérifient juste le code HTTP (200 / 401).
 *   - Ici on prouve l'effet de bord RÉEL : une signature valide → la mutation
 *     est PERSISTÉE en Postgres ; une signature invalide / replay / tamper →
 *     401 ET la table `Tenant` reste vide. Le middleware doit court-circuiter
 *     AVANT que le handler n'écrive quoi que ce soit.
 *
 * On utilise `POST /api/tenants/provision` comme mutation observable : si elle
 * passe, une row Tenant apparaît ; si le HMAC rejette, rien.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  resetDb,
  type BridgeHarness,
} from "../_harness/index.js";
import { signedFetch } from "../_harness/signed-fetch.js";

let h: BridgeHarness;

before(async () => {
  // skipHmac:false (défaut) — les tests HMAC DOIVENT signer.
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

beforeEach(async () => {
  await resetDb(h.prisma);
});

function provisionBody(tenantId: string) {
  return {
    tenant_id: tenantId,
    owner_email: "owner@hmac.example",
    workspace_name: "HMAC Test Workspace",
    plan: "pro",
  };
}

// ─── 1. Signature valide → 200 ET mutation persistée ────────────────────────

test("HMAC valide → 200 et la row Tenant est RÉELLEMENT en Postgres", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_ok"),
  );
  assert.equal(res.status, 200);

  // La mutation a vraiment touché Postgres.
  const row = await h.prisma.tenant.findUnique({
    where: { hubTenantId: "hub_hmac_ok" },
  });
  assert.ok(row, "signature valide → le Tenant doit exister en DB");
  assert.equal(await h.prisma.tenant.count(), 1);
});

// ─── 2. Signature invalide → 401 ET rien en DB ──────────────────────────────

test("HMAC signature bidon → 401 et AUCUNE row en Postgres", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_badsig"),
    { signatureOverride: "deadbeef".repeat(8) },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string; error_code: string };
  assert.equal(body.error, "unauthorized");
  assert.equal(body.error_code, "invalid_signature");

  // Le middleware a court-circuité : le handler n'a JAMAIS tourné.
  assert.equal(
    await h.prisma.tenant.count(),
    0,
    "signature invalide → rien ne doit être écrit",
  );
});

test("HMAC mauvais secret → 401 et rien en DB", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_wrongsecret"),
    { secret: "un-autre-secret-totalement-faux-32c!" },
  );
  assert.equal(res.status, 401);
  assert.equal(await h.prisma.tenant.count(), 0);
});

test("HMAC header signature absent → 401, rien en DB", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_nosig"),
    { omitSignature: true },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "missing_signature");
  assert.equal(await h.prisma.tenant.count(), 0);
});

test("HMAC header timestamp absent → 401, rien en DB", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_nots"),
    { omitTimestamp: true },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "missing_timestamp");
  assert.equal(await h.prisma.tenant.count(), 0);
});

// ─── 3. Replay attack → 401 ─────────────────────────────────────────────────

test("HMAC replay (timestamp vieux de 10 min) → 401 timestamp_drift, rien en DB", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_replay"),
    { timestampOverride: Date.now() - 10 * 60 * 1000 },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "timestamp_drift");
  assert.equal(
    await h.prisma.tenant.count(),
    0,
    "un replay ne doit JAMAIS persister une mutation",
  );
});

test("HMAC timestamp futur (+10 min, horloge en avance) → 401 timestamp_drift", async () => {
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_future"),
    { timestampOverride: Date.now() + 10 * 60 * 1000 },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "timestamp_drift");
  assert.equal(await h.prisma.tenant.count(), 0);
});

test("HMAC timestamp à la limite (4 min) → accepté, mutation persistée", async () => {
  // 4 min < fenêtre 5 min → doit passer. Garde-fou : la fenêtre n'est pas
  // trop stricte au point de rejeter une horloge légèrement décalée.
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_edge"),
    { timestampOverride: Date.now() - 4 * 60 * 1000 },
  );
  assert.equal(res.status, 200);
  assert.equal(await h.prisma.tenant.count(), 1);
});

test("HMAC timestamp non numérique → 401 invalid_timestamp", async () => {
  // signedFetch sérialise timestampOverride via String() ; NaN devient "NaN".
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_nan"),
    { timestampOverride: Number.NaN },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "invalid_timestamp");
  assert.equal(await h.prisma.tenant.count(), 0);
});

// ─── 4. Body tampered après signature → 401 ─────────────────────────────────

test("HMAC body modifié après signature → 401, rien en DB", async () => {
  // La signature est calculée sur le body légitime, mais on envoie un body
  // différent. Le middleware re-signe les octets reçus → mismatch.
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_clean"),
    {
      bodyAfterSign: JSON.stringify({
        tenant_id: "hub_hmac_tampered",
        owner_email: "evil@attacker.example",
        workspace_name: "Injected Workspace",
        plan: "enterprise",
      }),
    },
  );
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error_code: string };
  assert.equal(body.error_code, "invalid_signature");

  // NI le body légitime NI le body injecté ne doivent être persistés.
  assert.equal(await h.prisma.tenant.count(), 0);
  assert.equal(
    await h.prisma.tenant.findUnique({
      where: { hubTenantId: "hub_hmac_tampered" },
    }),
    null,
    "le body injecté ne doit jamais atteindre Postgres",
  );
});

test("HMAC body tronqué d'un seul caractère → 401", async () => {
  const legit = JSON.stringify(provisionBody("hub_hmac_trunc"));
  const res = await signedFetch(
    h.url,
    "POST",
    "/api/tenants/provision",
    provisionBody("hub_hmac_trunc"),
    { bodyAfterSign: legit.slice(0, -1) }, // 1 octet en moins
  );
  assert.equal(res.status, 401);
  assert.equal(await h.prisma.tenant.count(), 0);
});
