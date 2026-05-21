/**
 * Query DSL pour le dashboard : reproduit en lecture la même shape que
 * l'API GSC searchAnalytics.query, mais sert depuis la table GscDaily.
 */

import type { PrismaClient } from "@prisma/client";

export type Dimension = "date" | "query" | "page" | "country" | "device";
export type FilterOperator =
  | "equals"
  | "notEquals"
  | "contains"
  | "notContains";
export type SearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";

export type DimensionFilter = {
  dimension: Dimension;
  operator: FilterOperator;
  expression: string;
};

export type QueryRequest = {
  gscPropertyId: string;
  startDate: string;
  endDate: string;
  dimensions?: Dimension[];
  filters?: DimensionFilter[];
  searchType?: SearchType;
  rowLimit?: number;
  startRow?: number;
  orderBy?: "clicks" | "impressions" | "ctr" | "position" | "date";
  orderDir?: "asc" | "desc";
};

export type QueryRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type QueryResponse = {
  rows: QueryRow[];
  totalRows: number;
  totals: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
  };
};

const COL_BY_DIM: Record<Dimension, string> = {
  date: '"date"',
  query: '"query"',
  page: '"page"',
  country: '"country"',
  device: '"device"',
};

const ORDER_COL: Record<NonNullable<QueryRequest["orderBy"]>, string> = {
  clicks: "clicks",
  impressions: "impressions",
  ctr: "ctr",
  position: "position",
  date: '"date"',
};

export function buildWhereFragments(req: QueryRequest): {
  whereParts: string[];
  params: unknown[];
} {
  const whereParts: string[] = [
    `"gscPropertyId" = $1`,
    `"date" >= $2`,
    `"date" <= $3`,
  ];
  const params: unknown[] = [
    req.gscPropertyId,
    new Date(`${req.startDate}T00:00:00Z`),
    new Date(`${req.endDate}T00:00:00Z`),
  ];
  let p = 4;

  if (req.searchType) {
    whereParts.push(`"searchType" = $${p++}`);
    params.push(req.searchType);
  }

  for (const f of req.filters ?? []) {
    const col = COL_BY_DIM[f.dimension];
    if (!col) continue;
    switch (f.operator) {
      case "equals":
        whereParts.push(`${col} = $${p++}`);
        params.push(f.expression);
        break;
      case "notEquals":
        whereParts.push(`${col} <> $${p++}`);
        params.push(f.expression);
        break;
      case "contains":
        whereParts.push(`${col} ILIKE $${p++}`);
        params.push(`%${f.expression}%`);
        break;
      case "notContains":
        whereParts.push(`${col} NOT ILIKE $${p++}`);
        params.push(`%${f.expression}%`);
        break;
    }
  }
  return { whereParts, params };
}

async function computeTotals(
  prisma: PrismaClient,
  req: QueryRequest,
): Promise<QueryResponse["totals"]> {
  const { whereParts, params } = buildWhereFragments(req);
  const sql = `
    SELECT
      COALESCE(SUM(clicks), 0)::int AS clicks,
      COALESCE(SUM(impressions), 0)::int AS impressions,
      CASE WHEN SUM(impressions) > 0
        THEN SUM(position * impressions)::float / SUM(impressions)
        ELSE 0 END AS position
    FROM "GscDaily"
    WHERE ${whereParts.join(" AND ")}
  `;
  const rows = (await prisma.$queryRawUnsafe(sql, ...params)) as Array<{
    clicks: number | bigint;
    impressions: number | bigint;
    position: number;
  }>;
  const clicks = Number(rows[0]?.clicks ?? 0);
  const impressions = Number(rows[0]?.impressions ?? 0);
  const position = Number(rows[0]?.position ?? 0);
  const ctr = impressions > 0 ? clicks / impressions : 0;
  return { clicks, impressions, ctr, position };
}

export async function queryProperty(
  prisma: PrismaClient,
  req: QueryRequest,
): Promise<QueryResponse> {
  const dimensions = (req.dimensions ?? []).filter((d): d is Dimension => d in COL_BY_DIM);
  const rowLimit = Math.min(Math.max(req.rowLimit ?? 1000, 1), 25000);
  const startRow = Math.max(req.startRow ?? 0, 0);
  const orderBy = req.orderBy ?? "clicks";
  const orderDir = req.orderDir === "asc" ? "ASC" : "DESC";

  const totals = await computeTotals(prisma, req);

  if (dimensions.length === 0) {
    const hasData = totals.clicks > 0 || totals.impressions > 0;
    return {
      rows: hasData
        ? [
            {
              keys: [],
              clicks: totals.clicks,
              impressions: totals.impressions,
              ctr: totals.ctr,
              position: totals.position,
            },
          ]
        : [],
      totalRows: hasData ? 1 : 0,
      totals,
    };
  }

  const dimCols = dimensions.map((d) => COL_BY_DIM[d]);
  const selectDims = dimensions.map((d) => `${COL_BY_DIM[d]} AS "${d}"`).join(", ");
  const groupDims = dimCols.join(", ");

  const { whereParts, params: whereParams } = buildWhereFragments(req);
  const params: unknown[] = [...whereParams];
  let p = params.length + 1;

  const limitSql = `LIMIT $${p++} OFFSET $${p++}`;
  params.push(rowLimit, startRow);

  const sql = `
    SELECT ${selectDims},
      SUM(clicks)::int AS clicks,
      SUM(impressions)::int AS impressions,
      CASE WHEN SUM(impressions) > 0
        THEN SUM(clicks)::float / SUM(impressions)
        ELSE 0 END AS ctr,
      CASE WHEN SUM(impressions) > 0
        THEN SUM(position * impressions)::float / SUM(impressions)
        ELSE 0 END AS position
    FROM "GscDaily"
    WHERE ${whereParts.join(" AND ")}
    GROUP BY ${groupDims}
    ORDER BY ${ORDER_COL[orderBy]} ${orderDir}
    ${limitSql}
  `;

  const raw = (await prisma.$queryRawUnsafe(sql, ...params)) as Array<
    Record<string, unknown>
  >;

  const rows: QueryRow[] = raw.map((r) => {
    const keys = dimensions.map((d) => {
      const v = r[d];
      if (d === "date") {
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === "string") return v.slice(0, 10);
      }
      return String(v ?? "");
    });
    return {
      keys,
      clicks: Number(r.clicks ?? 0),
      impressions: Number(r.impressions ?? 0),
      ctr: Number(r.ctr ?? 0),
      position: Number(r.position ?? 0),
    };
  });

  const countSql = `
    SELECT COUNT(*)::int AS total FROM (
      SELECT 1 FROM "GscDaily"
      WHERE ${whereParts.join(" AND ")}
      GROUP BY ${groupDims}
    ) sub
  `;
  const countRaw = (await prisma.$queryRawUnsafe(countSql, ...whereParams)) as Array<{
    total: number | bigint;
  }>;

  return {
    rows,
    totalRows: Number(countRaw[0]?.total ?? rows.length),
    totals,
  };
}

export async function dashboardSummary(
  prisma: PrismaClient,
  opts: {
    workspaceId: string;
    days: number;
    searchType?: SearchType;
    gscPropertyId?: string;
  },
): Promise<{
  property: { id: string; siteUrl: string } | null;
  totals: QueryResponse["totals"];
  topQueries: QueryRow[];
  topPages: QueryRow[];
  timeseries: QueryRow[];
}> {
  let gscPropertyId = opts.gscPropertyId;
  let property: { id: string; siteUrl: string } | null = null;

  if (!gscPropertyId) {
    const tenant = await prisma.tenant.findUnique({
      where: { workspaceId: opts.workspaceId },
      include: {
        gscProperties: {
          where: { ownershipState: "verified" },
          orderBy: { lastSyncAt: "desc" },
          take: 1,
        },
      },
    });
    if (!tenant || tenant.gscProperties.length === 0) {
      const empty: QueryResponse["totals"] = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
      return { property: null, totals: empty, topQueries: [], topPages: [], timeseries: [] };
    }
    gscPropertyId = tenant.gscProperties[0].id;
    property = { id: gscPropertyId, siteUrl: tenant.gscProperties[0].siteUrl };
  } else {
    const p = await prisma.gscProperty.findUnique({
      where: { id: gscPropertyId },
      select: { id: true, siteUrl: true },
    });
    if (p) property = p;
  }

  const endDate = new Date(Date.now() - 2 * 86400000);
  const startDate = new Date(endDate.getTime() - (opts.days - 1) * 86400000);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const baseReq = {
    gscPropertyId,
    startDate: startStr,
    endDate: endStr,
    searchType: opts.searchType,
  } as const;

  const [topQueriesRes, topPagesRes, timeseriesRes] = await Promise.all([
    queryProperty(prisma, { ...baseReq, dimensions: ["query"], rowLimit: 50 }),
    queryProperty(prisma, { ...baseReq, dimensions: ["page"], rowLimit: 50 }),
    queryProperty(prisma, {
      ...baseReq,
      dimensions: ["date"],
      rowLimit: 365,
      orderBy: "date",
      orderDir: "asc",
    }),
  ]);

  return {
    property,
    totals: topQueriesRes.totals,
    topQueries: topQueriesRes.rows,
    topPages: topPagesRes.rows,
    timeseries: timeseriesRes.rows,
  };
}
