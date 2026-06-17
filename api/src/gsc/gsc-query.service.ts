import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../database/clickhouse.service';
import { GscRepository } from './gsc.repository';
import { GscSearchType } from './entities/gsc-daily.entity';

/**
 * Lecture analytique du dashboard GSC — port natif du bridge `gsc/query.ts`.
 *
 * Reproduit la shape de réponse de `dashboardSummary` (totals + topQueries +
 * topPages + timeseries) mais depuis ClickHouse (`gsc_daily`) au lieu de
 * Postgres-bridge. La console (`gsc/api.ts` → `GscDashboardResponse`) consomme
 * cette shape SANS changement.
 *
 * Règle métier critique conservée du bridge : la **position moyenne est
 * pondérée par les impressions** (SUM(position*impressions)/SUM(impressions)),
 * jamais moyennée naïvement — sinon une requête à 1 impression en position 90
 * pèserait autant qu'une requête à 10000 impressions en position 2. Idem CTR =
 * SUM(clicks)/SUM(impressions), recalculé sur l'agrégat, pas moyenné.
 */

export type GscQueryRow = {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscTotals = {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
};

export type GscDashboardSummary = {
  property: { id: string; siteUrl: string } | null;
  totals: GscTotals;
  topQueries: GscQueryRow[];
  topPages: GscQueryRow[];
  timeseries: GscQueryRow[];
};

const DAILY_TABLE = 'gsc_daily';
const EMPTY_TOTALS: GscTotals = {
  clicks: 0,
  impressions: 0,
  ctr: 0,
  position: 0,
};

interface AggDbRow {
  k: string;
  clicks: number | string;
  impressions: number | string;
  position: number;
}

@Injectable()
export class GscQueryService {
  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly repo: GscRepository,
  ) {}

  /**
   * Résumé dashboard pour un workspace sur `days` jours (fenêtre cohérente
   * avec le sync : on s'arrête à aujourd'hui-2j, latence GSC). Si le workspace
   * n'a pas de property `verified`, on renvoie `property: null` (l'UI affiche
   * l'onboarding) — exactement comme le bridge.
   */
  async dashboardSummary(opts: {
    workspaceId: string;
    days: number;
    searchType?: GscSearchType;
    now?: () => Date;
  }): Promise<GscDashboardSummary> {
    const prop = await this.repo.findPropertyByWorkspace(opts.workspaceId);
    if (!prop || prop.ownership_state !== 'verified' || !prop.site_url) {
      return {
        property: null,
        totals: EMPTY_TOTALS,
        topQueries: [],
        topPages: [],
        timeseries: [],
      };
    }

    const now = opts.now ? opts.now() : new Date();
    const endDate = new Date(now.getTime() - 2 * 86_400_000);
    const startDate = new Date(
      endDate.getTime() - (Math.max(opts.days, 1) - 1) * 86_400_000,
    );
    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    const searchType = opts.searchType ?? 'web';

    const [totals, topQueries, topPages, timeseries] = await Promise.all([
      this.totals(prop.id, searchType, startStr, endStr),
      this.groupBy(prop.id, searchType, startStr, endStr, 'query', 'clicks', 50),
      this.groupBy(prop.id, searchType, startStr, endStr, 'page', 'clicks', 50),
      this.groupBy(prop.id, searchType, startStr, endStr, 'date', 'date', 365),
    ]);

    return {
      property: { id: prop.id, siteUrl: prop.site_url },
      totals,
      topQueries,
      topPages,
      timeseries,
    };
  }

  /** Totals pondérés sur la fenêtre. */
  private async totals(
    gscPropertyId: string,
    searchType: GscSearchType,
    startDate: string,
    endDate: string,
  ): Promise<GscTotals> {
    const rows = await this.clickhouse.querySystem<{
      clicks: number | string;
      impressions: number | string;
      position: number;
    }>(
      `SELECT
         toUInt64(sum(clicks)) AS clicks,
         toUInt64(sum(impressions)) AS impressions,
         if(sum(impressions) > 0,
            sum(position * impressions) / sum(impressions),
            0) AS position
       FROM ${DAILY_TABLE} FINAL
       WHERE gsc_property_id = {gsc_property_id:String}
         AND search_type = {search_type:String}
         AND date >= {start:String}
         AND date <= {end:String}`,
      {
        gsc_property_id: gscPropertyId,
        search_type: searchType,
        start: startDate,
        end: endDate,
      },
    );
    const clicks = Number(rows[0]?.clicks ?? 0);
    const impressions = Number(rows[0]?.impressions ?? 0);
    const position = Number(rows[0]?.position ?? 0);
    return {
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position,
    };
  }

  /**
   * Agrégat groupé par une dimension (`query` | `page` | `date`), trié.
   * `orderBy='date'` → tri chronologique ascendant (pour la timeseries),
   * sinon tri descendant sur les clics (top N).
   */
  private async groupBy(
    gscPropertyId: string,
    searchType: GscSearchType,
    startDate: string,
    endDate: string,
    dimension: 'query' | 'page' | 'date',
    orderBy: 'clicks' | 'date',
    limit: number,
  ): Promise<GscQueryRow[]> {
    const orderSql =
      orderBy === 'date' ? 'k ASC' : 'clicks DESC, impressions DESC';
    const rows = await this.clickhouse.querySystem<AggDbRow>(
      `SELECT
         ${dimension} AS k,
         toUInt64(sum(clicks)) AS clicks,
         toUInt64(sum(impressions)) AS impressions,
         if(sum(impressions) > 0,
            sum(position * impressions) / sum(impressions),
            0) AS position
       FROM ${DAILY_TABLE} FINAL
       WHERE gsc_property_id = {gsc_property_id:String}
         AND search_type = {search_type:String}
         AND date >= {start:String}
         AND date <= {end:String}
       GROUP BY k
       ORDER BY ${orderSql}
       LIMIT {limit:UInt32}`,
      {
        gsc_property_id: gscPropertyId,
        search_type: searchType,
        start: startDate,
        end: endDate,
        limit: Math.min(Math.max(limit, 1), 25_000),
      },
    );
    return rows.map((r) => {
      const clicks = Number(r.clicks ?? 0);
      const impressions = Number(r.impressions ?? 0);
      return {
        keys: [String(r.k ?? '')],
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position: Number(r.position ?? 0),
      };
    });
  }
}
