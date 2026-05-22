/**
 * Tests unitaires — providers VoIP (U8).
 *
 * Couvre `src/credentials/providers.ts` :
 *   - parse / validation Zod par provider (OVH, Telnyx)
 *   - masquage des secrets (jamais de clear-text)
 *   - testConnection avec fetch mocké (succès, 401, erreur réseau)
 *   - registry getProvider / isCredentialKind
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  getProvider,
  isCredentialKind,
  maskSecret,
  CREDENTIAL_KINDS,
} from "../src/credentials/providers.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockFetch(
  routes: Record<string, { status: number; body?: unknown }>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const match = Object.keys(routes).find((k) => url.includes(k));
    const r = match ? routes[match] : { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => String(r.body ?? ""),
      json: async () => r.body ?? {},
    } as unknown as Response;
  }) as typeof fetch;
}

// ─── maskSecret ─────────────────────────────────────────────────────────────

test("maskSecret garde les 4 derniers caractères", () => {
  assert.equal(maskSecret("KEY0123456789abcdef"), "••••cdef");
  assert.equal(maskSecret("abcd"), "••••");
  assert.equal(maskSecret("ab"), "••••");
  assert.equal(maskSecret(""), "");
});

// ─── Registry ───────────────────────────────────────────────────────────────

test("isCredentialKind reconnaît les kinds valides", () => {
  assert.ok(isCredentialKind("voip_ovh"));
  assert.ok(isCredentialKind("voip_telnyx"));
  assert.ok(!isCredentialKind("voip_unknown"));
  assert.ok(!isCredentialKind(""));
});

test("getProvider throw sur kind inconnu", () => {
  assert.throws(() => getProvider("voip_nope"));
});

test("CREDENTIAL_KINDS et PROVIDERS sont cohérents", () => {
  for (const kind of CREDENTIAL_KINDS) {
    assert.ok(PROVIDERS[kind], `provider manquant pour ${kind}`);
    assert.equal(PROVIDERS[kind].kind, kind);
  }
});

// ─── OVH ────────────────────────────────────────────────────────────────────

test("OVH parse accepte des creds valides", () => {
  const p = getProvider("voip_ovh");
  const creds = p.parse({
    applicationKey: "ak",
    applicationSecret: "as",
    consumerKey: "ck",
  });
  assert.equal((creds as { applicationKey: string }).applicationKey, "ak");
  // endpoint a un défaut ovh-eu
  assert.equal((creds as { endpoint: string }).endpoint, "ovh-eu");
});

test("OVH parse rejette des creds incomplets", () => {
  const p = getProvider("voip_ovh");
  assert.throws(() => p.parse({ applicationKey: "ak" }));
  assert.throws(() => p.parse({}));
});

test("OVH mask ne laisse fuiter aucun secret en clair", () => {
  const p = getProvider("voip_ovh");
  const creds = p.parse({
    applicationKey: "applicationkey-1234",
    applicationSecret: "applicationsecret-5678",
    consumerKey: "consumerkey-9012",
  });
  const masked = p.mask(creds as never);
  assert.equal(masked.applicationKey, "••••1234");
  assert.equal(masked.applicationSecret, "••••5678");
  assert.equal(masked.consumerKey, "••••9012");
  // Aucune valeur masquée ne contient le secret complet.
  for (const v of Object.values(masked)) {
    assert.ok(!v.includes("applicationsecret-5678"));
  }
});

test("OVH testConnection succès quand /me répond 200", async () => {
  const p = getProvider("voip_ovh");
  const creds = p.parse({
    applicationKey: "ak",
    applicationSecret: "as",
    consumerKey: "ck",
  });
  const fetchImpl = mockFetch({
    "/auth/time": { status: 200, body: "1700000000" },
    "/me": { status: 200, body: { nichandle: "ab12345-ovh" } },
  });
  const result = await p.testConnection(creds as never, fetchImpl);
  assert.equal(result.ok, true);
  assert.match(result.message, /OVH/);
});

test("OVH testConnection échec sur 403", async () => {
  const p = getProvider("voip_ovh");
  const creds = p.parse({
    applicationKey: "ak",
    applicationSecret: "as",
    consumerKey: "ck",
  });
  const fetchImpl = mockFetch({
    "/auth/time": { status: 200, body: "1700000000" },
    "/me": { status: 403 },
  });
  const result = await p.testConnection(creds as never, fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.message, /refus/);
});

test("OVH testConnection gère une erreur réseau", async () => {
  const p = getProvider("voip_ovh");
  const creds = p.parse({
    applicationKey: "ak",
    applicationSecret: "as",
    consumerKey: "ck",
  });
  const fetchImpl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  const result = await p.testConnection(creds as never, fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.message, /impossible/);
});

// ─── Telnyx ─────────────────────────────────────────────────────────────────

test("Telnyx parse accepte une apiKey valide", () => {
  const p = getProvider("voip_telnyx");
  const creds = p.parse({ apiKey: "KEY01ABCDEF0123456789" });
  assert.equal((creds as { apiKey: string }).apiKey, "KEY01ABCDEF0123456789");
});

test("Telnyx parse rejette une apiKey trop courte", () => {
  const p = getProvider("voip_telnyx");
  assert.throws(() => p.parse({ apiKey: "short" }));
  assert.throws(() => p.parse({}));
});

test("Telnyx mask masque l'apiKey", () => {
  const p = getProvider("voip_telnyx");
  const creds = p.parse({ apiKey: "KEY01ABCDEF0123456789" });
  const masked = p.mask(creds as never);
  assert.equal(masked.apiKey, "••••6789");
  assert.ok(!masked.apiKey.includes("KEY01ABCDEF"));
});

test("Telnyx testConnection succès quand /balance répond 200", async () => {
  const p = getProvider("voip_telnyx");
  const creds = p.parse({ apiKey: "KEY01ABCDEF0123456789" });
  const fetchImpl = mockFetch({
    "api.telnyx.com/v2/balance": {
      status: 200,
      body: { data: { balance: "10.00" } },
    },
  });
  const result = await p.testConnection(creds as never, fetchImpl);
  assert.equal(result.ok, true);
  assert.match(result.message, /Telnyx/);
});

test("Telnyx testConnection échec sur 401", async () => {
  const p = getProvider("voip_telnyx");
  const creds = p.parse({ apiKey: "KEY01ABCDEF0123456789" });
  const fetchImpl = mockFetch({
    "api.telnyx.com/v2/balance": { status: 401 },
  });
  const result = await p.testConnection(creds as never, fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.message, /refus/);
});

test("Telnyx testConnection gère une erreur réseau", async () => {
  const p = getProvider("voip_telnyx");
  const creds = p.parse({ apiKey: "KEY01ABCDEF0123456789" });
  const fetchImpl = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const result = await p.testConnection(creds as never, fetchImpl);
  assert.equal(result.ok, false);
  assert.match(result.message, /impossible/);
});
