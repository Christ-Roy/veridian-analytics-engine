/**
 * Tests unitaires — client OVH Telephony (B-VOIP).
 *
 * Couvre `src/voip/providers/ovh.ts` : normalisation des consommations,
 * pull CDR avec mock HTTP (auth/time → /telephony → /service →
 * voiceConsumption → détails), découverte multi-lignes, filtrage par
 * fenêtre de dates, gestion 404 d'une conso individuelle.
 *
 * Les credentials sont la shape `OvhCreds` de U8 (`src/credentials/providers`)
 * — 3 clés + endpoint. billingAccount / serviceName sont DÉCOUVERTS par le
 * client depuis l'API OVH, pas saisis.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchOvhCdr,
  normalizeOvhConsumption,
} from "../../src/voip/providers/ovh.js";
import { VoipApiError } from "../../src/voip/types.js";
import type { OvhCreds } from "../../src/credentials/providers.js";

const CREDS: OvhCreds = {
  applicationKey: "app-key",
  applicationSecret: "app-secret",
  consumerKey: "consumer-key",
  endpoint: "ovh-eu",
};

/**
 * Mock fetch OVH : /auth/time, /telephony (billingAccounts),
 * /telephony/{ba}/service (serviceNames), /voiceConsumption (ids) et
 * /voiceConsumption/{id} (détail).
 */
function mockOvh(opts: {
  billingAccounts: string[];
  services: Record<string, string[]>;
  consumptionIds: Record<string, number[]>; // clé = `${ba}/${sn}`
  details: Record<number, unknown>;
  time?: number;
  missing404?: number[];
}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.endsWith("/auth/time")) {
      return {
        ok: true,
        status: 200,
        text: async () => String(opts.time ?? 1716200000),
      } as unknown as Response;
    }
    // détail conso : .../voiceConsumption/{id}
    const detailMatch = url.match(/\/voiceConsumption\/(\d+)$/);
    if (detailMatch) {
      const id = Number(detailMatch[1]);
      if (opts.missing404?.includes(id)) {
        return {
          ok: false,
          status: 404,
          json: async () => ({}),
          text: async () => "not_found",
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => opts.details[id] ?? {},
        text: async () => "",
      } as unknown as Response;
    }
    // liste consos : /telephony/{ba}/service/{sn}/voiceConsumption
    const consoMatch = url.match(
      /\/telephony\/([^/]+)\/service\/([^/]+)\/voiceConsumption$/,
    );
    if (consoMatch) {
      const key = `${decodeURIComponent(consoMatch[1])}/${decodeURIComponent(consoMatch[2])}`;
      return {
        ok: true,
        status: 200,
        json: async () => opts.consumptionIds[key] ?? [],
        text: async () => "",
      } as unknown as Response;
    }
    // liste services : /telephony/{ba}/service
    const svcMatch = url.match(/\/telephony\/([^/]+)\/service$/);
    if (svcMatch) {
      const ba = decodeURIComponent(svcMatch[1]);
      return {
        ok: true,
        status: 200,
        json: async () => opts.services[ba] ?? [],
        text: async () => "",
      } as unknown as Response;
    }
    // liste billingAccounts : /telephony
    if (url.endsWith("/telephony")) {
      return {
        ok: true,
        status: 200,
        json: async () => opts.billingAccounts,
        text: async () => "",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
}

// ─── normalizeOvhConsumption ────────────────────────────────────────────────

test("normalizeOvhConsumption: mappe wayType/durée/numéros correctement", () => {
  const n = normalizeOvhConsumption({
    consumptionId: 42,
    wayType: "incoming",
    calling: "+33612345678",
    called: "+33972000000",
    duration: 125,
    creationDatetime: "2026-05-15T10:30:00Z",
  });
  assert.ok(n);
  assert.equal(n.externalId, "42");
  assert.equal(n.direction, "inbound");
  assert.equal(n.fromNumber, "+33612345678");
  assert.equal(n.toNumber, "+33972000000");
  assert.equal(n.durationSec, 125);
  assert.equal(n.status, "answered");
  assert.equal(n.startedAt.toISOString(), "2026-05-15T10:30:00.000Z");
});

test("normalizeOvhConsumption: durée 0 → status missed", () => {
  const n = normalizeOvhConsumption({
    consumptionId: 1,
    wayType: "incoming",
    duration: 0,
    creationDatetime: "2026-05-15T10:00:00Z",
  });
  assert.equal(n?.status, "missed");
});

test("normalizeOvhConsumption: wayType outgoing → outbound", () => {
  const n = normalizeOvhConsumption({
    consumptionId: 2,
    wayType: "outgoing",
    duration: 30,
    creationDatetime: "2026-05-15T10:00:00Z",
  });
  assert.equal(n?.direction, "outbound");
});

test("normalizeOvhConsumption: sans consumptionId → null", () => {
  assert.equal(normalizeOvhConsumption({ wayType: "incoming" }), null);
});

// ─── fetchOvhCdr ────────────────────────────────────────────────────────────

test("fetchOvhCdr: découvre les lignes, pull les consos, normalise et filtre par fenêtre", async () => {
  const mock = mockOvh({
    billingAccounts: ["ba1"],
    services: { ba1: ["line-a"] },
    consumptionIds: { "ba1/line-a": [100, 101, 102] },
    details: {
      100: {
        consumptionId: 100,
        wayType: "incoming",
        calling: "+33611111111",
        called: "+33972000000",
        duration: 60,
        creationDatetime: "2026-05-15T12:00:00Z",
      },
      101: {
        consumptionId: 101,
        wayType: "outgoing",
        calling: "+33972000000",
        called: "+33622222222",
        duration: 0,
        creationDatetime: "2026-05-16T12:00:00Z",
      },
      // hors fenêtre → filtré
      102: {
        consumptionId: 102,
        wayType: "incoming",
        duration: 10,
        creationDatetime: "2026-01-01T12:00:00Z",
      },
    },
  });

  const calls = await fetchOvhCdr(CREDS, {
    since: new Date("2026-05-10T00:00:00Z"),
    until: new Date("2026-05-20T00:00:00Z"),
    fetchImpl: mock,
  });

  assert.equal(calls.length, 2, "la conso hors fenêtre est filtrée");
  assert.equal(calls[0].externalId, "100");
  assert.equal(calls[0].direction, "inbound");
  assert.equal(calls[1].externalId, "101");
  assert.equal(calls[1].status, "missed");
});

test("fetchOvhCdr: agrège les consos de plusieurs lignes et plusieurs comptes", async () => {
  const mock = mockOvh({
    billingAccounts: ["ba1", "ba2"],
    services: { ba1: ["line-a"], ba2: ["line-b"] },
    consumptionIds: { "ba1/line-a": [1], "ba2/line-b": [2] },
    details: {
      1: {
        consumptionId: 1,
        wayType: "incoming",
        duration: 10,
        creationDatetime: "2026-05-15T12:00:00Z",
      },
      2: {
        consumptionId: 2,
        wayType: "incoming",
        duration: 20,
        creationDatetime: "2026-05-16T12:00:00Z",
      },
    },
  });
  const calls = await fetchOvhCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    until: new Date("2026-05-31T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.equal(calls.length, 2, "les consos des 2 lignes sont agrégées");
});

test("fetchOvhCdr: une conso individuelle en 404 est sautée (pas de throw)", async () => {
  const mock = mockOvh({
    billingAccounts: ["ba1"],
    services: { ba1: ["line-a"] },
    consumptionIds: { "ba1/line-a": [200, 201] },
    details: {
      201: {
        consumptionId: 201,
        wayType: "incoming",
        duration: 5,
        creationDatetime: "2026-05-15T12:00:00Z",
      },
    },
    missing404: [200],
  });
  const calls = await fetchOvhCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    until: new Date("2026-05-31T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.equal(calls.length, 1, "la conso 404 est sautée, la 201 remonte");
  assert.equal(calls[0].externalId, "201");
});

test("fetchOvhCdr: /auth/time en échec → VoipApiError", async () => {
  const failTime = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/auth/time")) {
      return {
        ok: false,
        status: 503,
        text: async () => "down",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;

  await assert.rejects(
    () =>
      fetchOvhCdr(CREDS, {
        since: new Date("2026-05-01T00:00:00Z"),
        fetchImpl: failTime,
      }),
    (e: unknown) =>
      e instanceof VoipApiError && (e as VoipApiError).provider === "ovh",
  );
});

test("fetchOvhCdr: compte sans ligne → aucun appel", async () => {
  const mock = mockOvh({
    billingAccounts: ["ba1"],
    services: { ba1: [] },
    consumptionIds: {},
    details: {},
  });
  const calls = await fetchOvhCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.deepEqual(calls, []);
});

test("fetchOvhCdr: ligne sans conso → aucun appel", async () => {
  const mock = mockOvh({
    billingAccounts: ["ba1"],
    services: { ba1: ["line-a"] },
    consumptionIds: { "ba1/line-a": [] },
    details: {},
  });
  const calls = await fetchOvhCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.deepEqual(calls, []);
});

test("fetchOvhCdr: /telephony en 403 → VoipApiError 403", async () => {
  const mock = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/auth/time")) {
      return {
        ok: true,
        status: 200,
        text: async () => "1716200000",
      } as unknown as Response;
    }
    if (url.endsWith("/telephony")) {
      return {
        ok: false,
        status: 403,
        text: async () => "forbidden",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => [],
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;
  await assert.rejects(
    () =>
      fetchOvhCdr(CREDS, {
        since: new Date("2026-05-01T00:00:00Z"),
        fetchImpl: mock,
      }),
    (e: unknown) =>
      e instanceof VoipApiError && (e as VoipApiError).status === 403,
  );
});
