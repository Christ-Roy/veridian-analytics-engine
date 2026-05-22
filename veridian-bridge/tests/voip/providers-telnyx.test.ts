/**
 * Tests unitaires — client Telnyx (Detail Records API, B-VOIP).
 *
 * Couvre `src/voip/providers/telnyx.ts` : normalisation des CDR, pagination,
 * backoff sur 429/5xx, mapping des statuts.
 *
 * Les credentials sont la shape `TelnyxCreds` de U8 (`{ apiKey }`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchTelnyxCdr,
  normalizeTelnyxCdr,
} from "../../src/voip/providers/telnyx.js";
import { VoipApiError } from "../../src/voip/types.js";
import type { TelnyxCreds } from "../../src/credentials/providers.js";

const CREDS: TelnyxCreds = { apiKey: "KEY_test_telnyx" };

// ─── normalizeTelnyxCdr ─────────────────────────────────────────────────────

test("normalizeTelnyxCdr: mappe direction/from/to/durée", () => {
  const n = normalizeTelnyxCdr({
    id: "cdr_abc",
    record_type: "cdr",
    direction: "inbound",
    from: "+33611111111",
    to: "+33972000000",
    duration: 90,
    status: "completed",
    started_at: "2026-05-15T09:00:00Z",
    recording_urls: ["https://rec.telnyx/abc.mp3"],
  });
  assert.ok(n);
  assert.equal(n.externalId, "cdr_abc");
  assert.equal(n.direction, "inbound");
  assert.equal(n.fromNumber, "+33611111111");
  assert.equal(n.toNumber, "+33972000000");
  assert.equal(n.durationSec, 90);
  assert.equal(n.status, "answered");
  assert.equal(n.recordingUrl, "https://rec.telnyx/abc.mp3");
  assert.equal(n.startedAt.toISOString(), "2026-05-15T09:00:00.000Z");
});

test("normalizeTelnyxCdr: durée en string est convertie", () => {
  const n = normalizeTelnyxCdr({
    id: "cdr_x",
    direction: "outbound",
    duration: "42" as unknown as number,
    status: "completed",
    started_at: "2026-05-15T09:00:00Z",
  });
  assert.equal(n?.durationSec, 42);
  assert.equal(n?.direction, "outbound");
});

test("normalizeTelnyxCdr: mapping des statuts", () => {
  const mk = (status: string) =>
    normalizeTelnyxCdr({
      id: "x",
      status,
      started_at: "2026-05-15T09:00:00Z",
    })?.status;
  assert.equal(mk("completed"), "answered");
  assert.equal(mk("busy"), "busy");
  assert.equal(mk("no-answer"), "missed");
  assert.equal(mk("canceled"), "missed");
  assert.equal(mk("failed"), "failed");
  assert.equal(mk("weird_unknown"), "failed");
});

test("normalizeTelnyxCdr: sans id → null", () => {
  assert.equal(normalizeTelnyxCdr({ status: "completed" }), null);
});

test("normalizeTelnyxCdr: pas de recording → recordingUrl null", () => {
  const n = normalizeTelnyxCdr({
    id: "x",
    status: "completed",
    started_at: "2026-05-15T09:00:00Z",
  });
  assert.equal(n?.recordingUrl, null);
});

// ─── fetchTelnyxCdr ─────────────────────────────────────────────────────────

/** Mock fetch Telnyx servant des pages de detail_records. */
function mockTelnyx(pages: unknown[][], totalPages?: number): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = input instanceof URL ? input.toString() : String(input);
    if (url.includes("/detail_records")) {
      const u = new URL(url);
      const page = Number(u.searchParams.get("page[number]") ?? "1");
      const data = pages[page - 1] ?? [];
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data,
          meta: { total_pages: totalPages ?? pages.length, page_number: page },
        }),
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

test("fetchTelnyxCdr: récupère et normalise une page de CDR", async () => {
  const mock = mockTelnyx([
    [
      {
        id: "c1",
        record_type: "cdr",
        direction: "inbound",
        from: "+33611111111",
        to: "+33972000000",
        duration: 30,
        status: "completed",
        started_at: "2026-05-15T09:00:00Z",
      },
      {
        id: "c2",
        record_type: "cdr",
        direction: "outbound",
        duration: 0,
        status: "no-answer",
        started_at: "2026-05-15T10:00:00Z",
      },
    ],
  ]);
  const calls = await fetchTelnyxCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    until: new Date("2026-05-31T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].externalId, "c1");
  assert.equal(calls[1].status, "missed");
});

test("fetchTelnyxCdr: pagination — récupère toutes les pages", async () => {
  // 2 pages de 250 records chacune pleine pour forcer le passage page 2.
  const fullPage = (prefix: string) =>
    Array.from({ length: 250 }, (_, i) => ({
      id: `${prefix}_${i}`,
      record_type: "cdr",
      direction: "inbound",
      duration: 10,
      status: "completed",
      started_at: "2026-05-15T09:00:00Z",
    }));
  const mock = mockTelnyx([fullPage("p1"), fullPage("p2")], 2);
  const calls = await fetchTelnyxCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.equal(calls.length, 500, "les 2 pages doivent être agrégées");
});

test("fetchTelnyxCdr: une page partielle stoppe la pagination", async () => {
  const mock = mockTelnyx(
    [
      [
        {
          id: "only1",
          record_type: "cdr",
          status: "completed",
          started_at: "2026-05-15T09:00:00Z",
        },
      ],
    ],
    5,
  ); // total_pages dit 5 mais la page renvoie < PAGE_SIZE → on s'arrête
  const calls = await fetchTelnyxCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.equal(calls.length, 1);
});

test("fetchTelnyxCdr: 429 transitoire → retry puis succès", async () => {
  let call = 0;
  const mock = (async (input: string | URL | Request) => {
    const url = String(input);
    if (!url.includes("/detail_records")) {
      return {
        ok: false,
        status: 404,
        text: async () => "x",
      } as unknown as Response;
    }
    call++;
    if (call === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => "rate_limited",
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "ok1",
            record_type: "cdr",
            status: "completed",
            started_at: "2026-05-15T09:00:00Z",
          },
        ],
        meta: { total_pages: 1 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as typeof fetch;

  const calls = await fetchTelnyxCdr(CREDS, {
    since: new Date("2026-05-01T00:00:00Z"),
    fetchImpl: mock,
  });
  assert.equal(calls.length, 1, "le 429 est absorbé par le retry");
  assert.ok(call >= 2, "le mock a été rappelé après le 429");
});

test("fetchTelnyxCdr: 5xx persistant → VoipApiError", async () => {
  const mock = (async (input: string | URL | Request) => {
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
  await assert.rejects(
    () =>
      fetchTelnyxCdr(CREDS, {
        since: new Date("2026-05-01T00:00:00Z"),
        fetchImpl: mock,
      }),
    (e: unknown) =>
      e instanceof VoipApiError && (e as VoipApiError).status === 503,
  );
});

test("fetchTelnyxCdr: 401 non-retryable → throw immédiat", async () => {
  let call = 0;
  const mock = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/detail_records")) {
      call++;
      return {
        ok: false,
        status: 401,
        text: async () => "unauthorized",
      } as unknown as Response;
    }
    return {
      ok: false,
      status: 404,
      text: async () => "x",
    } as unknown as Response;
  }) as typeof fetch;
  await assert.rejects(
    () =>
      fetchTelnyxCdr(CREDS, {
        since: new Date("2026-05-01T00:00:00Z"),
        fetchImpl: mock,
      }),
    (e: unknown) =>
      e instanceof VoipApiError && (e as VoipApiError).status === 401,
  );
  assert.equal(call, 1, "un 401 ne doit pas être retried");
});
