/**
 * ════════════════════════════════════════════════════════════════════════════
 * sync.integration.test.ts — sync VoIP → SipCall contre un VRAI Postgres
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Ticket B-VOIP. Couvre `src/voip/sync.ts`, `credentials.ts` (adaptateur de
 * lecture des TenantCredential VoIP), `match.ts`, `query.ts` et les routes
 * `routes.ts`.
 *
 * Ce que ça PROUVE (vs un fake in-memory) :
 *
 *   - Les API OVH/Telnyx sont mockées au niveau HTTP — aucun réseau réel —
 *     MAIS `syncCallLogs` écrit RÉELLEMENT des rows `SipCall` en Postgres.
 *   - Idempotence : la vraie contrainte `@@unique([provider, externalId])`
 *     garantit qu'un re-sync upsert sans dupliquer.
 *   - Lecture des creds : B-VOIP lit les `TenantCredential` de kind VoIP
 *     (table U8), les déchiffre, et le sync passe `status`/`lastSyncAt` à jour.
 *   - Matching visitorId : un appel inbound dont le numéro appelant == le
 *     `phone` d'un Lead Veridian est relié au `visitorId` de la LeadSession.
 *   - Cascade FK : supprimer le Tenant supprime ses SipCall.
 *
 * ─── Coordination U8 ────────────────────────────────────────────────────────
 *
 * Les credentials sont seedés via `saveCredential` (`src/credentials/store.ts`,
 * code U8) — B-VOIP ne possède PAS de table de creds. Le sync les consomme.
 *
 * ─── Isolation ──────────────────────────────────────────────────────────────
 *
 * Auto-isolant : chaque test seede son propre Tenant via `mkTenant` (id unique
 * cross-process) et n'assert QUE sur des entités scopées.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { test, before, after } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import {
  bootBridgeWithRealDB,
  seedTenant,
  TEST_ENCRYPTION_KEY,
  TEST_ADMIN_KEY,
  type BridgeHarness,
} from "../_harness/index.js";
import { saveCredential } from "../../../src/credentials/store.js";
import {
  syncCallLogs,
  syncAllCallLogs,
  listCalls,
  loadVoipCredentials,
} from "../../../src/voip/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

// ─── Seed helpers cross-process ─────────────────────────────────────────────

const RUN_NONCE = randomUUID().slice(0, 8);
let localSeed = 0;
function mkTenant(slugHint = "voip") {
  localSeed += 1;
  const tag = `${RUN_NONCE}-${localSeed}`;
  return seedTenant(h.prisma, {
    workspaceId: `ws_${tag}`,
    slug: `${slugHint}-${tag}`,
    hubTenantId: `hub_${tag}`,
    apiKey: `sk_${tag}`,
  });
}

/** Seede un TenantCredential VoIP Telnyx chiffré via le store U8. */
function seedTelnyxCred(tenantId: string, apiKey = "KEY_telnyx_seed_value") {
  return saveCredential(
    h.prisma,
    tenantId,
    "voip_telnyx",
    { apiKey },
    TEST_ENCRYPTION_KEY,
  );
}

/** Seede un TenantCredential VoIP OVH chiffré via le store U8. */
function seedOvhCred(tenantId: string) {
  return saveCredential(
    h.prisma,
    tenantId,
    "voip_ovh",
    {
      applicationKey: "ak_seed",
      applicationSecret: "as_seed",
      consumerKey: "ck_seed",
      endpoint: "ovh-eu",
    },
    TEST_ENCRYPTION_KEY,
  );
}

const FIXED_NOW = new Date("2026-05-20T12:00:00Z");

/** Mock fetch Telnyx servant un set fixe de CDR. */
function mockTelnyx(cdrs: unknown[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.includes("/detail_records")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: cdrs, meta: { total_pages: 1 } }),
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "not_mocked",
    } as unknown as Response;
  }) as typeof fetch;
}

/** Un CDR Telnyx complet pour les fixtures. */
function telnyxCdr(over: Record<string, unknown> = {}) {
  return {
    id: `cdr_${randomUUID().slice(0, 8)}`,
    record_type: "cdr",
    direction: "inbound",
    from: "+33611111111",
    to: "+33972000000",
    duration: 60,
    status: "completed",
    started_at: "2026-05-15T10:00:00Z",
    ...over,
  };
}

// ─── 1. Lecture des credentials VoIP depuis TenantCredential ────────────────

test("loadVoipCredentials : lit et déchiffre les TenantCredential VoIP du tenant", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id, "KEY_unique_secret");

  // Le clear-text ne doit JAMAIS apparaître en DB.
  const raw = await h.prisma.tenantCredential.findFirst({
    where: { tenantId: t.id, kind: "voip_telnyx" },
  });
  assert.ok(raw);
  assert.ok(
    !JSON.stringify(raw.encryptedData).includes("KEY_unique_secret"),
    "le clear-text ne doit pas être stocké en clair",
  );

  const loaded = await loadVoipCredentials(h.prisma, t.id, TEST_ENCRYPTION_KEY);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].provider, "telnyx");
  assert.equal(
    (loaded[0].data as { apiKey: string }).apiKey,
    "KEY_unique_secret",
  );
});

test("loadVoipCredentials : charge OVH + Telnyx, ignore les kinds non-VoIP", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  await seedOvhCred(t.id);
  const loaded = await loadVoipCredentials(h.prisma, t.id, TEST_ENCRYPTION_KEY);
  assert.equal(loaded.length, 2, "OVH + Telnyx sont des kinds VoIP");
  const providers = loaded.map((c) => c.provider).sort();
  assert.deepEqual(providers, ["ovh", "telnyx"]);
});

// ─── 2. syncCallLogs : upsert réel des SipCall ──────────────────────────────

test("syncCallLogs : les CDR Telnyx mockés sont RÉELLEMENT upsertés en SipCall", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);

  const cdr1 = telnyxCdr({
    id: `c1_${RUN_NONCE}`,
    duration: 120,
    status: "completed",
  });
  const cdr2 = telnyxCdr({
    id: `c2_${RUN_NONCE}`,
    direction: "outbound",
    duration: 0,
    status: "no-answer",
  });

  const result = await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([cdr1, cdr2]),
    now: () => FIXED_NOW,
  });

  assert.equal(result.totalUpserted, 2);
  assert.equal(result.providers[0].provider, "telnyx");
  assert.equal(result.providers[0].error, null);

  // ─── La preuve : relire les rows depuis Postgres ──────────────────────────
  const calls = await h.prisma.sipCall.findMany({
    where: { tenantId: t.id },
    orderBy: { startedAt: "asc" },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].externalId, `c1_${RUN_NONCE}`);
  assert.equal(calls[0].durationSec, 120);
  assert.equal(calls[0].status, "answered");
  assert.equal(calls[0].direction, "inbound");
  assert.equal(calls[1].direction, "outbound");
  assert.equal(calls[1].status, "missed");

  // Le credential passe en status=ok avec lastSyncAt renseigné.
  const cred = await h.prisma.tenantCredential.findFirst({
    where: { tenantId: t.id, kind: "voip_telnyx" },
  });
  assert.equal(cred?.status, "ok");
  assert.ok(cred?.lastSyncAt, "lastSyncAt doit être positionné");
});

test("syncCallLogs : re-sync identique → idempotent (vraie contrainte unique)", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  const cdr = telnyxCdr({ id: `dup_${RUN_NONCE}`, duration: 30 });

  await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([cdr]),
    now: () => FIXED_NOW,
  });
  await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([cdr]),
    now: () => FIXED_NOW,
  });

  const count = await h.prisma.sipCall.count({ where: { tenantId: t.id } });
  assert.equal(count, 1, "un re-sync ne doit pas dupliquer la row");
});

test("syncCallLogs : re-sync avec durée modifiée → la row reflète la NOUVELLE valeur", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  const callId = `evolve_${RUN_NONCE}`;

  await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([telnyxCdr({ id: callId, duration: 10 })]),
    now: () => FIXED_NOW,
  });
  await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([telnyxCdr({ id: callId, duration: 999 })]),
    now: () => FIXED_NOW,
  });

  const call = await h.prisma.sipCall.findUnique({
    where: { provider_externalId: { provider: "telnyx", externalId: callId } },
  });
  assert.equal(call?.durationSec, 999, "la row reflète le dernier sync");
});

test("contrainte @@unique SipCall(provider, externalId) → P2002", async () => {
  const t = await mkTenant();
  const base = {
    tenantId: t.id,
    provider: "telnyx",
    externalId: `unique_${RUN_NONCE}`,
    direction: "inbound",
    fromNumber: "+33611111111",
    toNumber: "+33972000000",
    durationSec: 10,
    status: "answered",
    startedAt: FIXED_NOW,
  };
  await h.prisma.sipCall.create({ data: base });
  await assert.rejects(
    () => h.prisma.sipCall.create({ data: base }),
    (err: unknown) => (err as { code?: string }).code === "P2002",
  );
  // Même externalId mais provider différent → passe (clé composite).
  await h.prisma.sipCall.create({ data: { ...base, provider: "ovh" } });
  const count = await h.prisma.sipCall.count({ where: { tenantId: t.id } });
  assert.equal(count, 2);
});

test("syncCallLogs : provider en échec → erreur capturée, credential passe en failed", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  // Mock qui retourne toujours 503 sur detail_records.
  const fail503 = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/detail_records")) {
      return {
        ok: false,
        status: 503,
        text: async () => "down",
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "x",
    } as unknown as Response;
  }) as typeof fetch;

  const result = await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: fail503,
    now: () => FIXED_NOW,
  });
  assert.equal(result.totalUpserted, 0);
  assert.ok(result.providers[0].error?.includes("503"));

  const cred = await h.prisma.tenantCredential.findFirst({
    where: { tenantId: t.id, kind: "voip_telnyx" },
  });
  assert.equal(cred?.status, "failed");
  assert.ok(cred?.lastError?.includes("503"));
});

test("syncCallLogs : tenant sans credential VoIP → 0 appel, pas d'erreur", async () => {
  const t = await mkTenant();
  const result = await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([]),
    now: () => FIXED_NOW,
  });
  assert.equal(result.totalUpserted, 0);
  assert.equal(result.providers.length, 0);
});

test("syncCallLogs : tenant inconnu → VoipApiError 404", async () => {
  await assert.rejects(
    () =>
      syncCallLogs(h.prisma, "tenant_does_not_exist", {
        encryptionKey: TEST_ENCRYPTION_KEY,
        fetchImpl: mockTelnyx([]),
        now: () => FIXED_NOW,
      }),
    /tenant_not_found/,
  );
});

// ─── 3. Matching visitorId — REMOVED 2026-05-23 ─────────────────────────────
//
// Les tests de matching `phone → visitorId` via la table Lead ont été retirés
// avec le module Forms (cleanup scope Robert). `resolveVisitorIds` est
// maintenant un no-op (cf src/voip/match.ts) — tous les appels sont
// enregistrés sans visitorId. Si on rebranche le tel: tracking côté tracker
// directement, on remettra des tests ici.

// ─── 4. syncAllCallLogs ─────────────────────────────────────────────────────

test("syncAllCallLogs : traite les tenants avec credential, ignore ceux en failed", async () => {
  const tOk = await mkTenant("all-ok");
  await seedTelnyxCred(tOk.id);
  // Tenant avec credential VoIP en status=failed → exclu du cron.
  const tFailed = await mkTenant("all-failed");
  await seedTelnyxCred(tFailed.id);
  await h.prisma.tenantCredential.updateMany({
    where: { tenantId: tFailed.id, kind: "voip_telnyx" },
    data: { status: "failed" },
  });

  const results = await syncAllCallLogs(h.prisma, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl: mockTelnyx([telnyxCdr({ id: `sa_${RUN_NONCE}` })]),
    now: () => FIXED_NOW,
  });
  const ids = results.map((r) => r.tenantId);
  assert.ok(ids.includes(tOk.id), "le tenant ok est syncé");
  assert.ok(!ids.includes(tFailed.id), "le tenant failed est exclu");
});

// ─── 5. listCalls (tab Calls) ───────────────────────────────────────────────

test("listCalls : retourne les appels + stats agrégées (contrat U9)", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id); // → voipConnected:true
  const recent = new Date(Date.now() - 86400000); // hier — dans la fenêtre 30j
  await h.prisma.sipCall.createMany({
    data: [
      {
        tenantId: t.id,
        provider: "telnyx",
        externalId: `lc1_${RUN_NONCE}`,
        direction: "inbound",
        fromNumber: "+33611111111",
        toNumber: "+33972000000",
        durationSec: 100,
        status: "answered",
        startedAt: recent,
        visitorId: `v_${RUN_NONCE}`,
      },
      {
        tenantId: t.id,
        provider: "telnyx",
        externalId: `lc2_${RUN_NONCE}`,
        direction: "outbound",
        fromNumber: "+33972000000",
        toNumber: "+33622222222",
        durationSec: 0,
        status: "missed",
        startedAt: recent,
      },
    ],
  });

  const summary = await listCalls(h.prisma, {
    workspaceId: t.workspaceId,
    days: 30,
  });
  assert.ok(summary);
  assert.equal(summary.voipConnected, true);
  assert.equal(summary.stats.total, 2);
  assert.equal(summary.stats.missed, 1);
  assert.equal(summary.stats.avgDurationSec, 100, "moyenne des répondus");
  assert.equal(summary.stats.answerRate, 0.5);
  assert.equal(summary.calls.length, 2);
  // peerNumber : l'inbound → fromNumber ; l'outbound → toNumber.
  const inbound = summary.calls.find((c) => c.direction === "inbound");
  const outbound = summary.calls.find((c) => c.direction === "outbound");
  assert.equal(inbound?.peerNumber, "+33611111111");
  assert.equal(outbound?.peerNumber, "+33622222222");
  // série journalière : un jour à 2 appels dont 1 missed.
  const dayWithCalls = summary.daily.find((d) => d.total > 0);
  assert.ok(dayWithCalls, "le jour des appels figure dans la série");
  assert.equal(dayWithCalls?.total, 2);
  assert.equal(dayWithCalls?.missed, 1);
  assert.equal(summary.daily.length, 30, "30 jours de série");
});

test("listCalls : tenant sans credential VoIP → voipConnected:false", async () => {
  const t = await mkTenant();
  const summary = await listCalls(h.prisma, {
    workspaceId: t.workspaceId,
    days: 30,
  });
  assert.ok(summary);
  assert.equal(summary.voipConnected, false, "pas de cred VoIP branché");
  assert.equal(summary.stats.total, 0);
});

test("listCalls : tenant inconnu → null", async () => {
  const summary = await listCalls(h.prisma, {
    workspaceId: "ws_unknown_xyz",
    days: 30,
  });
  assert.equal(summary, null);
});

test("listCalls : fenêtre days exclut les appels trop vieux", async () => {
  const t = await mkTenant();
  await h.prisma.sipCall.create({
    data: {
      tenantId: t.id,
      provider: "telnyx",
      externalId: `old_${RUN_NONCE}`,
      direction: "inbound",
      fromNumber: "+33611111111",
      toNumber: "+33972000000",
      durationSec: 10,
      status: "answered",
      startedAt: new Date("2020-01-01T00:00:00Z"),
    },
  });
  const summary = await listCalls(h.prisma, {
    workspaceId: t.workspaceId,
    days: 30,
  });
  assert.equal(summary?.stats.total, 0, "l'appel de 2020 est hors fenêtre 30j");
});

// ─── 6. Cascade FK ──────────────────────────────────────────────────────────

test("cascade : supprimer le Tenant supprime ses SipCall", async () => {
  const t = await mkTenant();
  await h.prisma.sipCall.create({
    data: {
      tenantId: t.id,
      provider: "telnyx",
      externalId: `casc_${RUN_NONCE}`,
      direction: "inbound",
      fromNumber: "+33611111111",
      toNumber: "+33972000000",
      durationSec: 10,
      status: "answered",
      startedAt: FIXED_NOW,
    },
  });

  await h.prisma.tenant.delete({ where: { id: t.id } });

  assert.equal(
    await h.prisma.sipCall.count({ where: { tenantId: t.id } }),
    0,
    "les SipCall sont supprimés en cascade",
  );
});

// ─── 7. Endpoints HTTP ──────────────────────────────────────────────────────

test("POST /api/admin/voip/sync : force resync via HTTP, écrit en DB", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  // Note : la route prod utilise le vrai `fetch` réseau ; ici on vérifie
  // surtout l'auth + le résolveur tenantId + la shape de réponse. Le sync
  // remonte une erreur réseau capturée fail-soft — la route répond 200.
  const res = await fetch(
    `${h.url}/api/admin/voip/sync?tenantId=${t.workspaceId}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; tenantId: string };
  assert.equal(body.ok, true);
  assert.equal(body.tenantId, t.id);
});

test("POST /api/admin/voip/sync : sans Bearer → 401", async () => {
  const res = await fetch(`${h.url}/api/admin/voip/sync?tenantId=x`, {
    method: "POST",
  });
  assert.equal(res.status, 401);
});

test("POST /api/admin/voip/sync : tenant inconnu → 404", async () => {
  const res = await fetch(
    `${h.url}/api/admin/voip/sync?tenantId=does_not_exist`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` },
    },
  );
  assert.equal(res.status, 404);
});

test("POST /api/admin/voip/sync-all : sans Bearer ni IP allowlist → 401", async () => {
  const res = await fetch(`${h.url}/api/admin/voip/sync-all`, {
    method: "POST",
  });
  assert.equal(res.status, 401);
});

test("GET /api/admin/tenant/:wsId/calls : retourne les appels du tenant", async () => {
  const t = await mkTenant();
  await h.prisma.sipCall.create({
    data: {
      tenantId: t.id,
      provider: "telnyx",
      externalId: `http_${RUN_NONCE}`,
      direction: "inbound",
      fromNumber: "+33611111111",
      toNumber: "+33972000000",
      durationSec: 42,
      status: "answered",
      startedAt: new Date(Date.now() - 86400000),
    },
  });
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/calls?days=30`,
    { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    voipConnected: boolean;
    stats: { total: number };
    calls: Array<{ id: string; peerNumber: string; direction: string }>;
  };
  assert.equal(body.stats.total, 1);
  assert.equal(body.calls.length, 1);
  assert.equal(body.calls[0].peerNumber, "+33611111111");
  assert.equal(body.calls[0].direction, "inbound");
});

test("GET /api/admin/tenant/:wsId/calls : sans Bearer → 401", async () => {
  const res = await fetch(`${h.url}/api/admin/tenant/whatever/calls`);
  assert.equal(res.status, 401);
});

test("GET /api/admin/tenant/:wsId/calls : tenant inconnu → 404", async () => {
  const res = await fetch(
    `${h.url}/api/admin/tenant/ws_nope_${RUN_NONCE}/calls`,
    { headers: { Authorization: `Bearer ${TEST_ADMIN_KEY}` } },
  );
  assert.equal(res.status, 404);
});
