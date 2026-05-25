/**
 * ════════════════════════════════════════════════════════════════════════════
 * phone-numbers.integration.test.ts — TenantPhoneNumber CRUD + dimension
 * `source` injectée dans les events `phone_call` poussés vers staminads.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Vision Robert 2026-05-25 : 1 numéro par source de trafic. Le bridge enrichit
 * chaque event `phone_call` avec `properties.source` (seo / ads / direct /
 * email / social / print / other) après lookup `(tenantId, toNumber)`.
 *
 * Couvre :
 *   - CRUD `/api/admin/tenant/:wsId/phone-numbers` (GET/POST/PUT/DELETE)
 *   - Validation E.164 (toE164 helper)
 *   - Contrainte unique (tenantId, e164) → 409
 *   - Sécurité cross-tenant (PUT/DELETE refuse une row d'un autre tenant)
 *   - Sync VoIP : `properties.source` injecté quand mapping existe,
 *     `'direct'` (default) sinon, `tracked_number_id` ajouté quand mappé
 *   - Cascade FK : delete Tenant → delete TenantPhoneNumber
 *
 * Auto-isolant via `mkTenant` cross-process (run nonce).
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
import { syncCallLogs } from "../../../src/voip/index.js";

let h: BridgeHarness;

before(async () => {
  h = await bootBridgeWithRealDB();
});

after(async () => {
  await h.close();
});

const RUN_NONCE = randomUUID().slice(0, 8);
let localSeed = 0;
function mkTenant(slugHint = "phone") {
  localSeed += 1;
  const tag = `${RUN_NONCE}-${localSeed}`;
  return seedTenant(h.prisma, {
    workspaceId: `ws_${tag}`,
    slug: `${slugHint}-${tag}`,
    hubTenantId: `hub_${tag}`,
    apiKey: `sk_${tag}`,
  });
}

function authHeaders() {
  return {
    Authorization: `Bearer ${TEST_ADMIN_KEY}`,
    "Content-Type": "application/json",
  };
}

const FIXED_NOW = new Date("2026-05-25T12:00:00Z");

// ─── 1. CRUD ─────────────────────────────────────────────────────────────

test("POST phone-numbers : crée un numéro valide et le normalise en E.164", async () => {
  const t = await mkTenant();
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      // format français national → doit être normalisé en +33...
      body: JSON.stringify({
        e164: "01 77 12 34 56",
        source: "seo",
        label: "ligne fixe SEO",
      }),
    },
  );
  assert.equal(res.status, 201);
  const body = (await res.json()) as {
    ok: boolean;
    phoneNumber: { e164: string; source: string; label: string | null };
  };
  assert.equal(body.ok, true);
  assert.equal(body.phoneNumber.e164, "+33177123456");
  assert.equal(body.phoneNumber.source, "seo");
  assert.equal(body.phoneNumber.label, "ligne fixe SEO");
});

test("POST phone-numbers : E.164 invalide → 400 invalid_e164", async () => {
  const t = await mkTenant();
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "abc", source: "seo" }),
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "invalid_e164");
});

test("POST phone-numbers : source non whitelistée → 400 invalid_source", async () => {
  const t = await mkTenant();
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000001", source: "pigeon" }),
    },
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string; allowed: string[] };
  assert.equal(body.error, "invalid_source");
  assert.ok(body.allowed.includes("seo"));
});

test("POST phone-numbers : doublon (tenantId, e164) → 409 already_exists", async () => {
  const t = await mkTenant();
  await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000002", source: "seo" }),
    },
  );
  const dup = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000002", source: "ads" }),
    },
  );
  assert.equal(dup.status, 409);
});

test("GET phone-numbers : liste les numéros du tenant + retourne allowedSources", async () => {
  const t = await mkTenant();
  await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000003", source: "seo" }),
    },
  );
  await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000004", source: "ads" }),
    },
  );
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    { headers: authHeaders() },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    phoneNumbers: Array<{ e164: string; source: string }>;
    allowedSources: string[];
  };
  assert.equal(body.phoneNumbers.length, 2);
  const sources = body.phoneNumbers.map((p) => p.source).sort();
  assert.deepEqual(sources, ["ads", "seo"]);
  assert.ok(body.allowedSources.includes("direct"));
});

test("PUT phone-numbers : update source + label", async () => {
  const t = await mkTenant();
  const created = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000005", source: "seo" }),
    },
  );
  const { phoneNumber } = (await created.json()) as {
    phoneNumber: { id: string };
  };

  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers/${phoneNumber.id}`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ source: "ads", label: "campagne Adwords été" }),
    },
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    phoneNumber: { source: string; label: string | null };
  };
  assert.equal(body.phoneNumber.source, "ads");
  assert.equal(body.phoneNumber.label, "campagne Adwords été");
});

test("PUT phone-numbers : tentative cross-tenant → 404", async () => {
  // Sécu : un admin ne peut pas update un numéro qui n'appartient pas au
  // tenant ciblé par l'URL (même s'il a l'id exact).
  const t1 = await mkTenant("xt1");
  const t2 = await mkTenant("xt2");
  const created = await fetch(
    `${h.url}/api/admin/tenant/${t1.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000006", source: "seo" }),
    },
  );
  const { phoneNumber } = (await created.json()) as {
    phoneNumber: { id: string };
  };
  // On vise le tenant t2 avec l'id de t1 → 404 (sécu).
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t2.workspaceId}/phone-numbers/${phoneNumber.id}`,
    {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify({ source: "ads" }),
    },
  );
  assert.equal(res.status, 404);
});

test("DELETE phone-numbers : supprime la row", async () => {
  const t = await mkTenant();
  const created = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers`,
    {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ e164: "+33177000007", source: "seo" }),
    },
  );
  const { phoneNumber } = (await created.json()) as {
    phoneNumber: { id: string };
  };
  const res = await fetch(
    `${h.url}/api/admin/tenant/${t.workspaceId}/phone-numbers/${phoneNumber.id}`,
    { method: "DELETE", headers: authHeaders() },
  );
  assert.equal(res.status, 200);
  const remaining = await h.prisma.tenantPhoneNumber.count({
    where: { id: phoneNumber.id },
  });
  assert.equal(remaining, 0);
});

test("sans Bearer → 401 sur tous les verbes CRUD", async () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
    const url =
      method === "GET" || method === "POST"
        ? `${h.url}/api/admin/tenant/whatever/phone-numbers`
        : `${h.url}/api/admin/tenant/whatever/phone-numbers/xxxid`;
    const res = await fetch(url, { method });
    assert.equal(res.status, 401, `${method} doit refuser sans Bearer`);
  }
});

// ─── 2. Dimension `source` injectée dans le push staminads ──────────────────

function seedTelnyxCred(tenantId: string) {
  return saveCredential(
    h.prisma,
    tenantId,
    "voip_telnyx",
    { apiKey: "KEY_phone_source_test" },
    TEST_ENCRYPTION_KEY,
  );
}

function telnyxCdr(over: Record<string, unknown> = {}) {
  return {
    id: `cdr_${randomUUID().slice(0, 8)}`,
    record_type: "cdr",
    direction: "inbound",
    from: "+33611111111",
    to: "+33177999001",
    duration: 60,
    status: "completed",
    started_at: "2026-05-20T10:00:00Z",
    ...over,
  };
}

function mockFetchWithCapture(cdrs: unknown[]) {
  const trackCalls: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = (async (input, init) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.includes("/detail_records")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: cdrs, meta: { total_pages: 1 } }),
        text: async () => "",
      } as unknown as Response;
    }
    if (url.includes("/api/track")) {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as unknown)
        : null;
      trackCalls.push({ url, body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true }),
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
  return { trackCalls, fetchImpl };
}

test("push staminads : `source` du mapping injecté quand TenantPhoneNumber existe", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  // Seed mapping : +33177999002 → ads
  const mapping = await h.prisma.tenantPhoneNumber.create({
    data: {
      tenantId: t.id,
      e164: "+33177999002",
      source: "ads",
      label: "google ads landing",
    },
  });
  const cdr = telnyxCdr({
    id: `src_ads_${RUN_NONCE}`,
    to: "+33177999002",
  });
  const { trackCalls, fetchImpl } = mockFetchWithCapture([cdr]);

  const result = await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl,
    now: () => FIXED_NOW,
  });

  assert.equal(result.providers[0].staminadsPushed, 1);
  assert.equal(trackCalls.length, 1);
  const payload = trackCalls[0].body as {
    actions: Array<{ properties: Record<string, string> }>;
  };
  assert.equal(payload.actions[0].properties.source, "ads");
  assert.equal(
    payload.actions[0].properties.tracked_number_id,
    mapping.id,
    "le tracked_number_id est exposé en properties pour filtrage Goals",
  );
});

test("push staminads : `source = 'direct'` par défaut quand aucun mapping", async () => {
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  // Aucun TenantPhoneNumber seedé pour ce tenant.
  const cdr = telnyxCdr({
    id: `src_default_${RUN_NONCE}`,
    to: "+33177999003",
  });
  const { trackCalls, fetchImpl } = mockFetchWithCapture([cdr]);

  await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl,
    now: () => FIXED_NOW,
  });

  assert.equal(trackCalls.length, 1);
  const payload = trackCalls[0].body as {
    actions: Array<{ properties: Record<string, string> }>;
  };
  assert.equal(payload.actions[0].properties.source, "direct");
  assert.equal(
    payload.actions[0].properties.tracked_number_id,
    undefined,
    "pas de tracked_number_id quand pas de mapping",
  );
});

test("push staminads : normalisation E.164 du toNumber match les mappings stockés", async () => {
  // Si un provider renvoie le `to` au format national (`0177999004`) alors
  // que le mapping est stocké en `+33177999004`, le lookup DOIT matcher.
  const t = await mkTenant();
  await seedTelnyxCred(t.id);
  await h.prisma.tenantPhoneNumber.create({
    data: {
      tenantId: t.id,
      e164: "+33177999004",
      source: "seo",
    },
  });
  const cdr = telnyxCdr({
    id: `src_norm_${RUN_NONCE}`,
    to: "0177999004", // format national, pas E.164
  });
  const { trackCalls, fetchImpl } = mockFetchWithCapture([cdr]);

  await syncCallLogs(h.prisma, t.id, {
    encryptionKey: TEST_ENCRYPTION_KEY,
    fetchImpl,
    now: () => FIXED_NOW,
  });

  const payload = trackCalls[0].body as {
    actions: Array<{ properties: Record<string, string> }>;
  };
  assert.equal(
    payload.actions[0].properties.source,
    "seo",
    "le toE164 helper doit normaliser 0177... → +33177... pour matcher",
  );
});

// ─── 3. Cascade FK ──────────────────────────────────────────────────────────

test("cascade : supprimer le Tenant supprime ses TenantPhoneNumber", async () => {
  const t = await mkTenant();
  await h.prisma.tenantPhoneNumber.create({
    data: { tenantId: t.id, e164: "+33177999005", source: "seo" },
  });
  await h.prisma.tenant.delete({ where: { id: t.id } });
  const count = await h.prisma.tenantPhoneNumber.count({
    where: { tenantId: t.id },
  });
  assert.equal(count, 0);
});
