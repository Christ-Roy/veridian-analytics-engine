/**
 * Tests sync GSC → DB :
 *   - querySearchAnalytics avec mock Google : parse rows, pagination
 *   - syncProperty : upsert correct, deletion période avant re-insert
 *   - syncProperty avec rate limit retry backoff
 *   - syncAllVerified : itère sur les properties verified
 *   - parseRow : extraction correcte des dimensions
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  syncProperty,
  syncAllVerified,
  querySearchAnalytics,
  parseRow,
  BULK_DIMENSIONS,
  encryptTokens,
  GscApiError,
  type OauthConfig,
  type OauthTokens,
  type GscRawRow,
} from "../src/gsc/index.js";
import { FakePrismaClient } from "./helpers/fake-prisma.js";

const KEY_HEX = "c".repeat(64);
const CFG: OauthConfig = {
  clientId: "id",
  clientSecret: "sec",
  redirectUri: "https://b/c",
  encryptionKey: KEY_HEX,
};

function freshTokensBlob() {
  const tokens: OauthTokens = {
    access_token: "AT",
    refresh_token: "RT",
    expires_at: Date.now() + 3600_000,
    scope: "s",
    token_type: "Bearer",
  };
  return encryptTokens(tokens, KEY_HEX);
}

test("parseRow maps keys to named fields", () => {
  const raw: GscRawRow = {
    keys: ["2026-05-01", "veridian analytics", "/pricing", "fra", "desktop"],
    clicks: 12,
    impressions: 250,
    ctr: 0.048,
    position: 3.5,
  };
  const r = parseRow(raw, BULK_DIMENSIONS, "web");
  assert.equal(r.date, "2026-05-01");
  assert.equal(r.query, "veridian analytics");
  assert.equal(r.page, "/pricing");
  assert.equal(r.country, "fra");
  assert.equal(r.device, "desktop");
  assert.equal(r.clicks, 12);
  assert.equal(r.impressions, 250);
  assert.equal(r.searchType, "web");
  assert.ok(Math.abs(r.position - 3.5) < 0.001);
});

test("parseRow handles missing dimensions gracefully", () => {
  const raw: GscRawRow = {
    keys: ["2026-05-01"],
    clicks: 1,
    impressions: 10,
    ctr: 0.1,
    position: 1.0,
  };
  const r = parseRow(raw, ["date"], "web");
  assert.equal(r.date, "2026-05-01");
  assert.equal(r.query, "");
  assert.equal(r.page, "");
});

function mockGoogleFetch(pages: GscRawRow[][]): {
  fetchImpl: typeof fetch;
  callCount: () => number;
} {
  let calls = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse((init?.body as string) ?? "{}");
    const startRow = body.startRow ?? 0;
    const pageSize = body.rowLimit ?? 5000;
    const pageIdx = Math.floor(startRow / pageSize);
    const rows = pages[pageIdx] ?? [];
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ rows }),
      text: async () => JSON.stringify({ rows }),
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, callCount: () => calls };
}

test("querySearchAnalytics paginates with small pageSize", async () => {
  // Use pageSize=2 → 2 full pages of 2 + 1 partial of 1
  const page1: GscRawRow[] = [
    { keys: ["2026-05-01", "a"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
    { keys: ["2026-05-01", "b"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
  ];
  const page2: GscRawRow[] = [
    { keys: ["2026-05-01", "c"], clicks: 1, impressions: 10, ctr: 0.1, position: 1 },
  ];
  const { fetchImpl, callCount } = mockGoogleFetch([page1, page2]);
  const rows = await querySearchAnalytics({
    accessToken: "AT",
    propertyUrl: "https://example.com/",
    startDate: "2026-05-01",
    endDate: "2026-05-01",
    dimensions: ["date", "query"],
    pageSize: 2,
    fetchImpl,
  });
  assert.equal(rows.length, 3);
  assert.equal(callCount(), 2);
});

test("querySearchAnalytics retries 429 with backoff", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: false,
        status: 429,
        text: async () => "rate limited",
        json: async () => ({}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ rows: [] }),
      text: async () => "{}",
    } as unknown as Response;
  }) as typeof fetch;
  const rows = await querySearchAnalytics({
    accessToken: "AT",
    propertyUrl: "https://example.com/",
    startDate: "2026-05-01",
    endDate: "2026-05-01",
    dimensions: ["date"],
    fetchImpl,
  });
  assert.equal(rows.length, 0);
  assert.equal(calls, 2);
});

test("querySearchAnalytics throws after 3 retries on persistent 500", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return {
      ok: false,
      status: 500,
      text: async () => "boom",
      json: async () => ({}),
    } as unknown as Response;
  }) as typeof fetch;
  await assert.rejects(
    () =>
      querySearchAnalytics({
        accessToken: "AT",
        propertyUrl: "https://example.com/",
        startDate: "2026-05-01",
        endDate: "2026-05-01",
        dimensions: ["date"],
        fetchImpl,
      }),
    GscApiError,
  );
  assert.equal(calls, 3);
});

test("querySearchAnalytics throws immediately on 4xx (no retry)", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return {
      ok: false,
      status: 403,
      text: async () => "permission denied",
      json: async () => ({}),
    } as unknown as Response;
  }) as typeof fetch;
  await assert.rejects(() =>
    querySearchAnalytics({
      accessToken: "AT",
      propertyUrl: "https://example.com/",
      startDate: "2026-05-01",
      endDate: "2026-05-01",
      dimensions: ["date"],
      fetchImpl,
    }),
  );
  assert.equal(calls, 1);
});

async function setupPropertyWithTokens(): Promise<{
  prisma: FakePrismaClient;
  propertyId: string;
}> {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_1", workspaceId: "ws_1", slug: "t1", name: "T1" },
  });
  const prop = await prisma.gscProperty.create({
    data: {
      tenantId: "tenant_1",
      siteUrl: "https://example.com/",
      type: "SITE",
      ownershipState: "verified",
      oauthAccount: freshTokensBlob(),
    },
  });
  return { prisma, propertyId: prop.id };
}

test("syncProperty inserts daily rows from GSC API", async () => {
  const { prisma, propertyId } = await setupPropertyWithTokens();
  const now = new Date("2026-05-10T00:00:00Z");
  const rows: GscRawRow[] = [
    { keys: ["2026-05-05", "veridian", "/pricing", "fra", "desktop"], clicks: 10, impressions: 100, ctr: 0.1, position: 3.2 },
    { keys: ["2026-05-06", "analytics", "/", "fra", "mobile"], clicks: 5, impressions: 80, ctr: 0.0625, position: 5.1 },
  ];
  const { fetchImpl } = mockGoogleFetch([rows]);
  const result = await syncProperty(prisma as unknown as import("@prisma/client").PrismaClient, propertyId, {
    days: 7,
    oauthConfig: CFG,
    fetchImpl,
    now: () => now,
  });
  assert.equal(result.upserted, 2);
  assert.equal(result.errors.length, 0);
  assert.equal(result.range.start, "2026-05-02");
  assert.equal(result.range.end, "2026-05-08");
  assert.equal(prisma.gscDailies.length, 2);
  const r0 = prisma.gscDailies[0];
  assert.equal(r0.query, "veridian");
  assert.equal(r0.page, "/pricing");
  assert.equal(r0.clicks, 10);
});

test("syncProperty filters out rows with missing query or page", async () => {
  const { prisma, propertyId } = await setupPropertyWithTokens();
  const rows: GscRawRow[] = [
    { keys: ["2026-05-05", "", "/p", "fra", "desktop"], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    { keys: ["2026-05-05", "q", "", "fra", "desktop"], clicks: 1, impressions: 1, ctr: 1, position: 1 },
    { keys: ["2026-05-05", "q", "/p", "fra", "desktop"], clicks: 1, impressions: 1, ctr: 1, position: 1 },
  ];
  const { fetchImpl } = mockGoogleFetch([rows]);
  await syncProperty(prisma as unknown as import("@prisma/client").PrismaClient, propertyId, {
    days: 7,
    oauthConfig: CFG,
    fetchImpl,
    now: () => new Date("2026-05-10T00:00:00Z"),
  });
  assert.equal(prisma.gscDailies.length, 1);
});

test("syncProperty deletes existing rows in period before re-insert", async () => {
  const { prisma, propertyId } = await setupPropertyWithTokens();
  prisma.gscDailies.push({
    id: "old1",
    gscPropertyId: propertyId,
    date: new Date("2026-05-05T00:00:00Z"),
    query: "old",
    page: "/old",
    country: "fra",
    device: "desktop",
    searchType: "web",
    impressions: 999,
    clicks: 999,
    position: 1,
    ctr: 1,
    createdAt: new Date(),
  });
  const rows: GscRawRow[] = [
    { keys: ["2026-05-05", "new", "/new", "fra", "desktop"], clicks: 10, impressions: 100, ctr: 0.1, position: 2 },
  ];
  const { fetchImpl } = mockGoogleFetch([rows]);
  await syncProperty(prisma as unknown as import("@prisma/client").PrismaClient, propertyId, {
    days: 7,
    oauthConfig: CFG,
    fetchImpl,
    now: () => new Date("2026-05-10T00:00:00Z"),
  });
  assert.equal(prisma.gscDailies.length, 1);
  assert.equal(prisma.gscDailies[0].query, "new");
});

test("syncProperty updates lastSyncAt", async () => {
  const { prisma, propertyId } = await setupPropertyWithTokens();
  const { fetchImpl } = mockGoogleFetch([[]]);
  await syncProperty(prisma as unknown as import("@prisma/client").PrismaClient, propertyId, {
    days: 7,
    oauthConfig: CFG,
    fetchImpl,
    now: () => new Date("2026-05-10T00:00:00Z"),
  });
  const prop = await prisma.gscProperty.findUnique({ where: { id: propertyId } });
  assert.ok(prop?.lastSyncAt instanceof Date);
});

test("syncProperty rejects placeholder property", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "tenant_1", workspaceId: "ws_1", slug: "t1", name: "T1" },
  });
  const prop = await prisma.gscProperty.create({
    data: {
      tenantId: "tenant_1",
      siteUrl: "__pending__",
      type: "SITE",
      ownershipState: "pending",
      oauthAccount: freshTokensBlob(),
    },
  });
  await assert.rejects(() =>
    syncProperty(prisma as unknown as import("@prisma/client").PrismaClient, prop.id, {
      days: 7,
      oauthConfig: CFG,
      fetchImpl: mockGoogleFetch([[]]).fetchImpl,
      now: () => new Date(),
    }),
  );
});

test("syncAllVerified iterates over verified properties only", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "t1", workspaceId: "ws_1", slug: "s1", name: "n1" },
  });
  await prisma.gscProperty.create({
    data: {
      tenantId: "t1",
      siteUrl: "https://a.com/",
      type: "SITE",
      ownershipState: "verified",
      oauthAccount: freshTokensBlob(),
    },
  });
  await prisma.gscProperty.create({
    data: {
      tenantId: "t1",
      siteUrl: "https://b.com/",
      type: "SITE",
      ownershipState: "pending",
      oauthAccount: freshTokensBlob(),
    },
  });
  const { fetchImpl } = mockGoogleFetch([[]]);
  const results = await syncAllVerified(prisma as unknown as import("@prisma/client").PrismaClient, {
    days: 7,
    oauthConfig: CFG,
    fetchImpl,
    now: () => new Date("2026-05-10T00:00:00Z"),
  });
  assert.equal(results.length, 1);
});
