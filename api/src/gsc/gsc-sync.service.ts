import { Injectable, Logger } from '@nestjs/common';
import { GscDailyRow, GscSearchType } from './entities/gsc-daily.entity';
import { GscProperty } from './entities/gsc-property.entity';
import { GscOauthService } from './gsc-oauth.service';
import { GscRepository } from './gsc.repository';
import { GscTokenCrypto } from './gsc-token-crypto';

/**
 * Sync GSC API → table `gsc_daily` — port natif du bridge `gsc/sync.ts`.
 *
 * Pour une property `verified`, on pull searchAnalytics.query dimensionné par
 * [date, query, page, country, device] sur N jours et on remplace la fenêtre
 * dans ClickHouse (idempotent).
 *
 * GSC a ~2j de latence avant que la data soit "final" → on sync jusqu'à
 * aujourd'hui-2j. Backoff exponentiel sur 429 / 5xx (3 tentatives, base 50ms).
 */

export type GscDimension = 'date' | 'query' | 'page' | 'country' | 'device';

export const BULK_DIMENSIONS: GscDimension[] = [
  'date',
  'query',
  'page',
  'country',
  'device',
];

interface GscRawRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export class GscApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export interface GscSyncResult {
  gscPropertyId: string;
  range: { start: string; end: string };
  searchTypes: GscSearchType[];
  upserted: number;
  errors: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

@Injectable()
export class GscSyncService {
  private readonly logger = new Logger(GscSyncService.name);

  constructor(
    private readonly repo: GscRepository,
    private readonly oauth: GscOauthService,
    private readonly crypto: GscTokenCrypto,
  ) {}

  /**
   * Renvoie un access_token valide pour la property, en le rafraîchissant +
   * persistant si nécessaire (marge de 30s avant expiration).
   */
  async getAccessToken(
    prop: GscProperty,
    fetchImpl: typeof fetch = fetch,
  ): Promise<string> {
    if (!prop.oauth_tokens_encrypted) {
      throw new GscApiError('oauth_tokens_missing', 401);
    }
    const tokens = this.crypto.decryptTokens(
      prop.oauth_tokens_encrypted,
      prop.workspace_id,
    );
    if (tokens.expires_at > Date.now() + 30_000) {
      return tokens.access_token;
    }
    const fresh = await this.oauth.refreshAccessToken(
      tokens.refresh_token,
      fetchImpl,
    );
    const updated = {
      ...tokens,
      access_token: fresh.access_token,
      expires_at: fresh.expires_at,
    };
    await this.repo.updateTokens(
      prop,
      this.crypto.encryptTokens(updated, prop.workspace_id),
    );
    return fresh.access_token;
  }

  /**
   * Pull une fenêtre searchAnalytics.query (paginée) avec backoff 429/5xx.
   */
  async querySearchAnalytics(opts: {
    accessToken: string;
    propertyUrl: string;
    startDate: string;
    endDate: string;
    dimensions: GscDimension[];
    searchType: GscSearchType;
    pageSize?: number;
    maxPages?: number;
    fetchImpl?: typeof fetch;
  }): Promise<GscRawRow[]> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const pageSize = opts.pageSize ?? 5000;
    const maxPages = opts.maxPages ?? 10;
    const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(
      opts.propertyUrl,
    )}/searchAnalytics/query`;

    const out: GscRawRow[] = [];
    for (let page = 0; page < maxPages; page++) {
      const body: Record<string, unknown> = {
        startDate: opts.startDate,
        endDate: opts.endDate,
        dimensions: opts.dimensions,
        rowLimit: pageSize,
        startRow: page * pageSize,
        dataState: 'final',
        type: opts.searchType,
      };

      let attempt = 0;
      let succeeded = false;
      let lastErr: GscApiError | null = null;
      while (attempt < 3) {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${opts.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const data = (await res.json()) as { rows?: GscRawRow[] };
          const rows = data.rows ?? [];
          out.push(...rows);
          succeeded = true;
          if (rows.length < pageSize) return out; // dernière page
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
        // 4xx non-retryable (403, 400…) → on remonte tout de suite.
        const txt = await res.text();
        throw new GscApiError(
          `gsc_query_failed status=${res.status} body=${txt.slice(0, 200)}`,
          res.status,
        );
      }
      if (!succeeded && lastErr) throw lastErr;
    }
    return out;
  }

  /**
   * Sync complet d'une property : refresh token → pull → replace window.
   */
  async syncProperty(
    prop: GscProperty,
    opts: {
      days?: number;
      searchTypes?: GscSearchType[];
      fetchImpl?: typeof fetch;
      now?: () => Date;
    } = {},
  ): Promise<GscSyncResult> {
    const days = opts.days ?? 30;
    const searchTypes = opts.searchTypes ?? ['web'];
    const fetchImpl = opts.fetchImpl ?? fetch;
    const now = opts.now ? opts.now() : new Date();

    const endDate = new Date(now.getTime() - 2 * 86_400_000);
    const startDate = new Date(endDate.getTime() - (days - 1) * 86_400_000);
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);

    const result: GscSyncResult = {
      gscPropertyId: prop.id,
      range: { start: startStr, end: endStr },
      searchTypes,
      upserted: 0,
      errors: [],
    };

    if (!prop.site_url || prop.ownership_state !== 'verified') {
      result.errors.push('property_not_verified');
      return result;
    }

    const accessToken = await this.getAccessToken(prop, fetchImpl);

    for (const st of searchTypes) {
      try {
        const rawRows = await this.querySearchAnalytics({
          accessToken,
          propertyUrl: prop.site_url,
          startDate: startStr,
          endDate: endStr,
          dimensions: BULK_DIMENSIONS,
          searchType: st,
          fetchImpl,
        });
        const parsed = rawRows
          .map((r) => this.parseRow(r, prop, st))
          .filter((r): r is GscDailyRow => r !== null);
        const n = await this.repo.replaceDailyWindow(
          prop.id,
          st,
          startStr,
          endStr,
          parsed,
        );
        result.upserted += n;
      } catch (e) {
        const msg =
          e instanceof GscApiError
            ? `[${e.status}] ${e.message}`
            : e instanceof Error
              ? e.message
              : 'unknown_error';
        result.errors.push(`${st}: ${msg}`);
      }
    }

    await this.repo.markSynced(prop);
    return result;
  }

  /** Sync de toutes les properties verified (appelé par le cron). */
  async syncAllVerified(
    opts: { days?: number; fetchImpl?: typeof fetch } = {},
  ): Promise<GscSyncResult[]> {
    const props = await this.repo.findVerifiedProperties();
    const out: GscSyncResult[] = [];
    for (const p of props) {
      try {
        out.push(
          await this.syncProperty(p, {
            days: opts.days ?? 7,
            fetchImpl: opts.fetchImpl,
          }),
        );
      } catch (e) {
        out.push({
          gscPropertyId: p.id,
          range: { start: '', end: '' },
          searchTypes: ['web'],
          upserted: 0,
          errors: [e instanceof Error ? e.message : 'unknown_error'],
        });
      }
    }
    return out;
  }

  /**
   * Mappe une row brute GSC vers une `GscDailyRow`. Renvoie null si la row n'a
   * pas les dimensions essentielles (query/page/date) — on n'agrège pas du
   * bruit partiel.
   */
  private parseRow(
    raw: GscRawRow,
    prop: GscProperty,
    searchType: GscSearchType,
  ): GscDailyRow | null {
    const keys = raw.keys ?? [];
    const byDim: Record<string, string> = {};
    for (let i = 0; i < BULK_DIMENSIONS.length; i++) {
      byDim[BULK_DIMENSIONS[i]] = keys[i] ?? '';
    }
    const date = byDim.date;
    const query = byDim.query;
    const page = byDim.page;
    if (!date || !query || !page) return null;
    return {
      gsc_property_id: prop.id,
      workspace_id: prop.workspace_id,
      date,
      query,
      page,
      country: byDim.country ?? '',
      device: byDim.device ?? '',
      search_type: searchType,
      impressions: Math.round(raw.impressions),
      clicks: Math.round(raw.clicks),
      position: raw.position,
      ctr: raw.ctr,
    };
  }
}
