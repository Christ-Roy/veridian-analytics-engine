/**
 * Sync GSC API → table GscDaily.
 *
 * Pour une GscProperty donnée, on demande à GSC les rows daily sur N jours,
 * dimensionnées par [date, query, page, country, device], pour chaque
 * searchType demandé. On upsert dans GscDaily.
 *
 * GSC a un délai ~2j avant que la data soit "final" : on sync jusqu'à
 * aujourd'hui-2j par défaut.
 *
 * Backoff exponentiel sur 429 / 5xx (max 3 retries, base 500ms).
 */

import type { PrismaClient } from "@prisma/client";
import { getAccessTokenForProperty, type OauthConfig } from "./oauth.js";

export type GscDimension = "date" | "query" | "page" | "country" | "device";
export type GscSearchType = "web" | "image" | "video" | "news" | "discover" | "googleNews";

export type GscRawRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export const BULK_DIMENSIONS: GscDimension[] = ["date", "query", "page", "country", "device"];

export class GscApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function querySearchAnalytics(opts: {
  accessToken: string;
  propertyUrl: string;
  startDate: string;
  endDate: string;
  dimensions: GscDimension[];
  searchType?: GscSearchType;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}): Promise<GscRawRow[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const pageSize = opts.pageSize ?? 5000;
  const maxPages = opts.maxPages ?? 10;
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(opts.propertyUrl)}/searchAnalytics/query`;

  const out: GscRawRow[] = [];
  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = {
      startDate: opts.startDate,
      endDate: opts.endDate,
      dimensions: opts.dimensions,
      rowLimit: pageSize,
      startRow: page * pageSize,
      dataState: "final",
    };
    if (opts.searchType) body.type = opts.searchType;

    let attempt = 0;
    let lastErr: GscApiError | null = null;
    let succeeded = false;
    while (attempt < 3) {
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const data = (await res.json()) as { rows?: GscRawRow[] };
        const rows = data.rows ?? [];
        out.push(...rows);
        succeeded = true;
        if (rows.length < pageSize) return out;
        lastErr = null;
        break;
      }
      if (res.status === 429 || res.status >= 500) {
        const txt = await res.text();
        lastErr = new GscApiError(
          `gsc_query_failed status=${res.status} body=${txt.slice(0, 200)}`,
          res.status,
        );
        await sleep(50 * Math.pow(2, attempt));
        attempt++;
        continue;
      }
      const txt = await res.text();
      throw new GscApiError(
        `gsc_query_failed status=${res.status} body=${txt.slice(0, 200)}`,
        res.status,
      );
    }
    if (lastErr && !succeeded) throw lastErr;
  }
  return out;
}

export function parseRow(
  raw: GscRawRow,
  dimensions: GscDimension[],
  searchType: GscSearchType,
): {
  date: string;
  query: string;
  page: string;
  country: string;
  device: string;
  searchType: GscSearchType;
  impressions: number;
  clicks: number;
  position: number;
  ctr: number;
} {
  const byDim: Record<string, string> = {};
  for (let i = 0; i < dimensions.length; i++) {
    byDim[dimensions[i]] = raw.keys[i] ?? "";
  }
  return {
    date: byDim.date ?? "",
    query: byDim.query ?? "",
    page: byDim.page ?? "",
    country: byDim.country ?? "",
    device: byDim.device ?? "",
    searchType,
    impressions: Math.round(raw.impressions),
    clicks: Math.round(raw.clicks),
    position: raw.position,
    ctr: raw.ctr,
  };
}

export interface SyncResult {
  gscPropertyId: string;
  range: { start: string; end: string };
  searchTypes: GscSearchType[];
  upserted: number;
  errors: string[];
}

export async function syncProperty(
  prisma: PrismaClient,
  gscPropertyId: string,
  opts: {
    days?: number;
    searchTypes?: GscSearchType[];
    oauthConfig: OauthConfig;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
): Promise<SyncResult> {
  const days = opts.days ?? 7;
  const searchTypes = opts.searchTypes ?? ["web"];
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ? opts.now() : new Date();

  const prop = await prisma.gscProperty.findUnique({ where: { id: gscPropertyId } });
  if (!prop) throw new GscApiError("property_not_found", 404);
  if (prop.siteUrl === "__pending__") {
    throw new GscApiError("property_pending_setup (siteUrl placeholder)", 400);
  }

  const endDate = new Date(now.getTime() - 2 * 86400000);
  const startDate = new Date(endDate.getTime() - (days - 1) * 86400000);
  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  const result: SyncResult = {
    gscPropertyId,
    range: { start: startStr, end: endStr },
    searchTypes,
    upserted: 0,
    errors: [],
  };

  const accessToken = await getAccessTokenForProperty(
    prisma,
    gscPropertyId,
    opts.oauthConfig,
    fetchImpl,
  );

  for (const st of searchTypes) {
    try {
      const rawRows = await querySearchAnalytics({
        accessToken,
        propertyUrl: prop.siteUrl,
        startDate: startStr,
        endDate: endStr,
        dimensions: BULK_DIMENSIONS,
        searchType: st,
        fetchImpl,
      });

      await prisma.gscDaily.deleteMany({
        where: {
          gscPropertyId,
          date: { gte: startDate, lte: endDate },
          searchType: st,
        },
      });

      const parsed = rawRows
        .map((r) => parseRow(r, BULK_DIMENSIONS, st))
        .filter((r) => r.query && r.page && r.date);

      const BATCH = 500;
      for (let i = 0; i < parsed.length; i += BATCH) {
        const chunk = parsed.slice(i, i + BATCH).map((r) => ({
          gscPropertyId,
          date: new Date(`${r.date}T00:00:00Z`),
          query: r.query,
          page: r.page,
          country: r.country,
          device: r.device,
          searchType: r.searchType,
          impressions: r.impressions,
          clicks: r.clicks,
          position: r.position,
          ctr: r.ctr,
        }));
        await prisma.gscDaily.createMany({ data: chunk, skipDuplicates: true });
        result.upserted += chunk.length;
      }
    } catch (e) {
      const msg =
        e instanceof GscApiError
          ? `[${e.status}] ${e.message}`
          : e instanceof Error
            ? e.message
            : "unknown_error";
      result.errors.push(`${st}: ${msg}`);
    }
  }

  await prisma.gscProperty.update({
    where: { id: gscPropertyId },
    data: { lastSyncAt: new Date() },
  });

  return result;
}

export async function syncAllVerified(
  prisma: PrismaClient,
  opts: {
    days?: number;
    searchTypes?: GscSearchType[];
    oauthConfig: OauthConfig;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  },
): Promise<SyncResult[]> {
  const props = await prisma.gscProperty.findMany({
    where: { ownershipState: "verified" },
    select: { id: true },
  });
  const out: SyncResult[] = [];
  for (const p of props) {
    try {
      out.push(await syncProperty(prisma, p.id, opts));
    } catch (e) {
      out.push({
        gscPropertyId: p.id,
        range: { start: "", end: "" },
        searchTypes: opts.searchTypes ?? ["web"],
        upserted: 0,
        errors: [e instanceof Error ? e.message : "unknown_error"],
      });
    }
  }
  return out;
}
