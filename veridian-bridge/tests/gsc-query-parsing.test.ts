/**
 * Tests query.ts :
 *   - buildWhereFragments : whitelist dimensions + filtres SQL corrects
 *   - queryProperty : agrégations sur fixtures pré-chargées
 *   - dashboardSummary : forme attendue de la réponse
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildWhereFragments,
  queryProperty,
  dashboardSummary,
} from "../src/gsc/index.js";
import { FakePrismaClient } from "./helpers/fake-prisma.js";

test("buildWhereFragments base: propertyId + date range", () => {
  const { whereParts, params } = buildWhereFragments({
    gscPropertyId: "p1",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
  });
  assert.equal(whereParts.length, 3);
  assert.deepEqual(params, [
    "p1",
    new Date("2026-05-01T00:00:00Z"),
    new Date("2026-05-31T00:00:00Z"),
  ]);
  assert.ok(whereParts[0].includes('"gscPropertyId" = $1'));
});

test("buildWhereFragments adds searchType", () => {
  const { whereParts, params } = buildWhereFragments({
    gscPropertyId: "p1",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
    searchType: "image",
  });
  assert.equal(whereParts.length, 4);
  assert.equal(params[3], "image");
  assert.ok(whereParts[3].includes('"searchType"'));
});

test("buildWhereFragments translates filter operators", () => {
  const { whereParts, params } = buildWhereFragments({
    gscPropertyId: "p1",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
    filters: [
      { dimension: "query", operator: "equals", expression: "veridian" },
      { dimension: "page", operator: "contains", expression: "pricing" },
      { dimension: "country", operator: "notEquals", expression: "fra" },
      { dimension: "device", operator: "notContains", expression: "mobile" },
    ],
  });
  assert.equal(whereParts.length, 7);
  assert.equal(params[3], "veridian");
  assert.equal(params[4], "%pricing%");
  assert.equal(params[5], "fra");
  assert.equal(params[6], "%mobile%");
  assert.ok(whereParts[4].includes("ILIKE"));
  assert.ok(whereParts[6].includes("NOT ILIKE"));
});

test("buildWhereFragments ignores unknown dimensions", () => {
  const { whereParts } = buildWhereFragments({
    gscPropertyId: "p1",
    startDate: "2026-05-01",
    endDate: "2026-05-31",
    filters: [
      {
        dimension: "unknown" as unknown as "query",
        operator: "equals",
        expression: "x",
      },
    ],
  });
  assert.equal(whereParts.length, 3);
});

function seedRows(prisma: FakePrismaClient, propertyId: string): void {
  const base = (
    date: string,
    query: string,
    page: string,
    clicks: number,
    impressions: number,
    position: number,
  ) => ({
    id: `${date}-${query}-${page}`,
    gscPropertyId: propertyId,
    date: new Date(`${date}T00:00:00Z`),
    query,
    page,
    country: "fra",
    device: "desktop",
    searchType: "web",
    clicks,
    impressions,
    position,
    ctr: impressions > 0 ? clicks / impressions : 0,
    createdAt: new Date(),
  });
  prisma.gscDailies.push(
    base("2026-05-01", "veridian", "/", 10, 100, 3),
    base("2026-05-01", "analytics", "/p", 5, 50, 5),
    base("2026-05-02", "veridian", "/", 20, 200, 2),
    base("2026-05-02", "seo", "/blog", 1, 10, 8),
  );
}

test("queryProperty totals aggregate over full set", async () => {
  const prisma = new FakePrismaClient();
  seedRows(prisma, "p1");
  const res = await queryProperty(
    prisma as unknown as import("@prisma/client").PrismaClient,
    {
      gscPropertyId: "p1",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    },
  );
  assert.equal(res.totals.clicks, 36);
  assert.equal(res.totals.impressions, 360);
  assert.ok(Math.abs(res.totals.ctr - 36 / 360) < 0.0001);
  const expectedPos = (3 * 100 + 5 * 50 + 2 * 200 + 8 * 10) / 360;
  assert.ok(Math.abs(res.totals.position - expectedPos) < 0.001);
});

test("queryProperty groups by dimension", async () => {
  const prisma = new FakePrismaClient();
  seedRows(prisma, "p1");
  const res = await queryProperty(
    prisma as unknown as import("@prisma/client").PrismaClient,
    {
      gscPropertyId: "p1",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      dimensions: ["query"],
      orderBy: "clicks",
      orderDir: "desc",
    },
  );
  assert.equal(res.rows.length, 3);
  assert.equal(res.rows[0].keys[0], "veridian");
  assert.equal(res.rows[0].clicks, 30);
});

test("queryProperty respects rowLimit cap (25000)", async () => {
  const prisma = new FakePrismaClient();
  const res = await queryProperty(
    prisma as unknown as import("@prisma/client").PrismaClient,
    {
      gscPropertyId: "p1",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      rowLimit: 999_999,
    },
  );
  assert.equal(res.rows.length, 0);
});

test("queryProperty returns empty totals when no data", async () => {
  const prisma = new FakePrismaClient();
  const res = await queryProperty(
    prisma as unknown as import("@prisma/client").PrismaClient,
    {
      gscPropertyId: "p_nonexistent",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
    },
  );
  assert.equal(res.totals.clicks, 0);
  assert.equal(res.rows.length, 0);
});

test("dashboardSummary returns empty when tenant has no verified property", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "t1", workspaceId: "ws_x", slug: "s", name: "n" },
  });
  const res = await dashboardSummary(
    prisma as unknown as import("@prisma/client").PrismaClient,
    {
      workspaceId: "ws_x",
      days: 30,
    },
  );
  assert.equal(res.property, null);
  assert.equal(res.totals.clicks, 0);
});

test("dashboardSummary resolves property + returns top queries/pages/timeseries", async () => {
  const prisma = new FakePrismaClient();
  await prisma.tenant.create({
    data: { id: "t1", workspaceId: "ws_x", slug: "s", name: "n" },
  });
  const prop = await prisma.gscProperty.create({
    data: {
      tenantId: "t1",
      siteUrl: "https://example.com/",
      type: "SITE",
      ownershipState: "verified",
      lastSyncAt: new Date(),
    },
  });
  const recent = new Date(Date.now() - 5 * 86400000);
  prisma.gscDailies.push({
    id: "r1",
    gscPropertyId: prop.id,
    date: recent,
    query: "veridian",
    page: "/",
    country: "fra",
    device: "desktop",
    searchType: "web",
    clicks: 10,
    impressions: 100,
    position: 3,
    ctr: 0.1,
    createdAt: new Date(),
  });
  const res = await dashboardSummary(
    prisma as unknown as import("@prisma/client").PrismaClient,
    {
      workspaceId: "ws_x",
      days: 30,
    },
  );
  assert.equal(res.property?.id, prop.id);
  assert.equal(res.topQueries.length, 1);
  assert.equal(res.topQueries[0].keys[0], "veridian");
  assert.equal(res.totals.clicks, 10);
});
