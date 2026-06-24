import { Injectable, BadRequestException, Inject } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { OnEvent } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { ClickHouseService } from '../database/clickhouse.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { ExtremesQueryDto, ExtremesResponse } from './dto/extremes-query.dto';
import {
  FunnelQueryDto,
  FunnelResponse,
  FunnelStepResult,
} from './dto/funnel-query.dto';
import { ConversionsByChannelDto } from './dto/conversions-by-channel.dto';
import { buildAnalyticsQuery, buildExtremesQuery } from './lib/query-builder';
import { buildFunnelQuery } from './lib/funnel-builder';
import {
  resolveDatePreset,
  fillGaps,
  shiftPresetToPreviousPeriod,
} from './lib/date-utils';
import { METRICS, MetricContext } from './constants/metrics';
import { DIMENSIONS } from './constants/dimensions';
import { AnalyticsTable } from './constants/tables';
import { Workspace } from '../workspaces/entities/workspace.entity';
import { isoToClickHouseDateTime } from '../common/utils/datetime.util';

const GRANULARITY_COLUMNS: Record<string, string> = {
  hour: 'date_hour',
  day: 'date_day',
  week: 'date_week',
  month: 'date_month',
  year: 'date_year',
};

/** Round to 2 decimals (percentages). */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface AnalyticsResponse {
  data:
    | Record<string, unknown>[]
    | {
        current: Record<string, unknown>[];
        previous: Record<string, unknown>[];
      };
  meta: {
    metrics: string[];
    dimensions: string[];
    granularity?: string;
    dateRange: { start: string; end: string };
    compareDateRange?: { start: string; end: string };
    total_rows: number;
  };
  // NOTE: on n'expose JAMAIS le SQL ClickHouse brut ni les paramètres dans la
  // réponse applicative (fuite de structure interne — OWASP, ticket leak-sql
  // 2026-06-24). La requête reste interne au service ; pour debug, la logger
  // côté serveur, pas la renvoyer au consommateur (Hub/IA/console).
}

/**
 * Hard cap on the number of tracked cache keys PER workspace. The cache key
 * embeds every query-shaping parameter (dimensions × filters × dates × metrics
 * × granularity × …), so the set of distinct keys a single workspace can
 * produce is effectively unbounded. `cacheManager` expires entries by TTL
 * (1-5 min) but `workspaceCacheKeys` only ever shrinks on a `backfill.completed`
 * event — which may NEVER fire for a workspace that never runs a backfill. Left
 * uncapped, the per-workspace Set grows forever → slow OOM on the long-running
 * NestJS process. We evict oldest-first (Set preserves insertion order) once the
 * cap is hit, same bounded-cache pattern as TwentyConnector.personCache /
 * GeoService. Overridable via ANALYTICS_CACHE_KEYS_MAX_PER_WORKSPACE.
 */
const DEFAULT_CACHE_KEYS_MAX_PER_WORKSPACE = 10_000;

@Injectable()
export class AnalyticsService {
  private readonly CACHE_TTL_HISTORICAL = 5 * 60 * 1000; // 5 min for historical
  private readonly CACHE_TTL_LIVE = 60 * 1000; // 1 min for queries including today
  private pendingQueries = new Map<string, Promise<AnalyticsResponse>>();
  private workspaceCacheKeys = new Map<string, Set<string>>();

  /** Hard size cap for each workspace's tracked-key Set (ENV-overridable). */
  private readonly cacheKeysMaxPerWorkspace: number = (() => {
    const raw = parseInt(
      process.env.ANALYTICS_CACHE_KEYS_MAX_PER_WORKSPACE || '',
      10,
    );
    return Number.isFinite(raw) && raw > 0
      ? raw
      : DEFAULT_CACHE_KEYS_MAX_PER_WORKSPACE;
  })();

  constructor(
    private readonly clickhouse: ClickHouseService,
    private readonly workspacesService: WorkspacesService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  async query(dto: AnalyticsQueryDto): Promise<AnalyticsResponse> {
    // Validate workspace exists and get timezone
    const workspace = await this.workspacesService.get(dto.workspace_id);
    const tz = dto.timezone || workspace.timezone || 'UTC';

    // Resolve date range from preset for cache key
    const resolvedDates = dto.dateRange.preset
      ? resolveDatePreset(dto.dateRange.preset, tz)
      : { start: dto.dateRange.start!, end: dto.dateRange.end! };

    const cacheKey = this.generateCacheKey(dto, resolvedDates, tz);

    // Check cache first
    const cached = await this.cacheManager.get<AnalyticsResponse>(cacheKey);
    if (cached) return cached;

    // Deduplicate concurrent identical requests
    if (this.pendingQueries.has(cacheKey)) {
      return this.pendingQueries.get(cacheKey)!;
    }

    // Execute query and cache result
    const queryPromise = this.executeQueryInternal(dto, workspace, tz)
      .then(async (result) => {
        const ttl = this.getTTL(resolvedDates, tz);
        await this.cacheManager.set(cacheKey, result, ttl);
        return result;
      })
      .finally(() => {
        this.pendingQueries.delete(cacheKey);
      });

    this.pendingQueries.set(cacheKey, queryPromise);
    return queryPromise;
  }

  private async executeQueryInternal(
    dto: AnalyticsQueryDto,
    workspace: Workspace,
    tz: string,
  ): Promise<AnalyticsResponse> {
    // Get table (default to sessions)
    const table: AnalyticsTable = dto.table || 'sessions';

    // Validate metrics
    for (const metric of dto.metrics) {
      if (!METRICS[metric]) {
        throw new BadRequestException(`Unknown metric: ${metric}`);
      }
      if (!METRICS[metric].tables.includes(table)) {
        throw new BadRequestException(
          `Metric '${metric}' is not available for table '${table}'`,
        );
      }
    }

    // Validate dimensions
    for (const dimension of dto.dimensions || []) {
      if (!DIMENSIONS[dimension]) {
        throw new BadRequestException(`Unknown dimension: ${dimension}`);
      }
      if (!DIMENSIONS[dimension].tables.includes(table)) {
        throw new BadRequestException(
          `Dimension '${dimension}' is not available for table '${table}'`,
        );
      }
    }

    // Validate metricFilters
    for (const mf of dto.metricFilters || []) {
      if (!METRICS[mf.metric]) {
        throw new BadRequestException(`Unknown metric: ${mf.metric}`);
      }
      if (!METRICS[mf.metric].tables.includes(table)) {
        throw new BadRequestException(
          `Metric '${mf.metric}' is not available for table '${table}'`,
        );
      }
    }

    // Resolve date range from preset if needed
    const resolvedDateRange = { ...dto.dateRange };
    if (dto.dateRange.preset) {
      const resolved = resolveDatePreset(dto.dateRange.preset, tz);
      resolvedDateRange.start = resolved.start;
      resolvedDateRange.end = resolved.end;
    }

    // Convert ISO dates to ClickHouse format if they contain 'T'
    if (resolvedDateRange.start?.includes('T')) {
      resolvedDateRange.start = isoToClickHouseDateTime(
        resolvedDateRange.start,
      )!;
    }
    if (resolvedDateRange.end?.includes('T')) {
      resolvedDateRange.end = isoToClickHouseDateTime(resolvedDateRange.end)!;
    }

    // Build query with resolved dates
    const queryDto = {
      ...dto,
      dateRange: resolvedDateRange,
    };

    // Build metric context from workspace settings
    const metricContext: MetricContext = {
      bounce_threshold: workspace.settings.bounce_threshold ?? 10,
    };

    // Handle comparison period
    if (dto.compareDateRange) {
      return this.queryWithComparison(queryDto, tz, metricContext);
    }

    // Build and execute query (pass timezone for granularity grouping)
    const { sql, params } = buildAnalyticsQuery(queryDto, tz, metricContext);
    // Query the workspace-specific database
    let data = await this.clickhouse.queryWorkspace<Record<string, unknown>>(
      dto.workspace_id,
      sql,
      params,
    );

    // Fill gaps if granularity is set (pass dimensions for per-dimension gap filling)
    const granularity = dto.dateRange.granularity;
    if (granularity && resolvedDateRange.start && resolvedDateRange.end) {
      const dateColumn = GRANULARITY_COLUMNS[granularity];
      data = fillGaps(
        data,
        granularity,
        dateColumn,
        resolvedDateRange.start,
        resolvedDateRange.end,
        dto.metrics,
        dto.dimensions || [],
        tz,
      );
    }

    return {
      data,
      meta: {
        metrics: dto.metrics,
        dimensions: dto.dimensions || [],
        granularity: dto.dateRange.granularity,
        dateRange: {
          start: resolvedDateRange.start!,
          end: resolvedDateRange.end!,
        },
        total_rows: data.length,
      },
    };
  }

  private async queryWithComparison(
    dto: AnalyticsQueryDto & { dateRange: { start?: string; end?: string } },
    tz: string,
    metricContext: MetricContext,
  ): Promise<AnalyticsResponse> {
    // Resolve comparison date range
    const compareDateRange = { ...dto.compareDateRange! };

    // Auto-shift: if same preset used for both, shift comparison to previous period
    if (
      dto.compareDateRange!.preset &&
      dto.dateRange.preset &&
      dto.compareDateRange!.preset === dto.dateRange.preset
    ) {
      const shifted = shiftPresetToPreviousPeriod(
        dto.compareDateRange!.preset,
        tz,
      );
      compareDateRange.start = shifted.start;
      compareDateRange.end = shifted.end;
    } else if (dto.compareDateRange!.preset) {
      const resolved = resolveDatePreset(dto.compareDateRange!.preset, tz);
      compareDateRange.start = resolved.start;
      compareDateRange.end = resolved.end;
    }

    // Convert ISO dates to ClickHouse format if they contain 'T'
    if (compareDateRange.start?.includes('T')) {
      compareDateRange.start = isoToClickHouseDateTime(compareDateRange.start)!;
    }
    if (compareDateRange.end?.includes('T')) {
      compareDateRange.end = isoToClickHouseDateTime(compareDateRange.end)!;
    }

    // Build current period query (pass timezone for granularity grouping)
    const { sql: currentSql, params: currentParams } = buildAnalyticsQuery(
      dto,
      tz,
      metricContext,
    );

    // Build previous period query
    const previousDto = {
      ...dto,
      dateRange: {
        ...compareDateRange,
        granularity: dto.dateRange.granularity,
      },
    };
    const { sql: previousSql, params: previousParams } = buildAnalyticsQuery(
      previousDto,
      tz,
      metricContext,
    );

    // Execute both queries against workspace database
    const [currentData, previousData] = await Promise.all([
      this.clickhouse.queryWorkspace<Record<string, unknown>>(
        dto.workspace_id,
        currentSql,
        currentParams,
      ),
      this.clickhouse.queryWorkspace<Record<string, unknown>>(
        dto.workspace_id,
        previousSql,
        previousParams,
      ),
    ]);

    // Fill gaps for both if granularity is set (pass dimensions for per-dimension gap filling)
    const granularity = dto.dateRange.granularity;
    let filledCurrent = currentData;
    let filledPrevious = previousData;

    if (granularity) {
      const dateColumn = GRANULARITY_COLUMNS[granularity];
      if (dto.dateRange.start && dto.dateRange.end) {
        filledCurrent = fillGaps(
          currentData,
          granularity,
          dateColumn,
          dto.dateRange.start,
          dto.dateRange.end,
          dto.metrics,
          dto.dimensions || [],
          tz,
        );
      }
      if (compareDateRange.start && compareDateRange.end) {
        filledPrevious = fillGaps(
          previousData,
          granularity,
          dateColumn,
          compareDateRange.start,
          compareDateRange.end,
          dto.metrics,
          dto.dimensions || [],
          tz,
        );
      }
    }

    return {
      data: {
        current: filledCurrent,
        previous: filledPrevious,
      },
      meta: {
        metrics: dto.metrics,
        dimensions: dto.dimensions || [],
        granularity: dto.dateRange.granularity,
        dateRange: { start: dto.dateRange.start!, end: dto.dateRange.end! },
        compareDateRange: {
          start: compareDateRange.start!,
          end: compareDateRange.end!,
        },
        total_rows: filledCurrent.length + filledPrevious.length,
      },
    };
  }

  getAvailableMetrics(table?: AnalyticsTable) {
    const all = Object.values(METRICS);
    return table ? all.filter((m) => m.tables.includes(table)) : all;
  }

  getAvailableDimensions(table?: AnalyticsTable) {
    if (!table) return DIMENSIONS;
    return Object.fromEntries(
      Object.entries(DIMENSIONS).filter(([, d]) => d.tables.includes(table)),
    );
  }

  async extremes(dto: ExtremesQueryDto): Promise<ExtremesResponse> {
    // Validate workspace exists and get timezone
    const workspace = await this.workspacesService.get(dto.workspace_id);
    const tz = dto.timezone || workspace.timezone || 'UTC';

    // Get table (default to sessions)
    const table: AnalyticsTable = dto.table || 'sessions';

    // Validate metric
    if (!METRICS[dto.metric]) {
      throw new BadRequestException(`Unknown metric: ${dto.metric}`);
    }
    if (!METRICS[dto.metric].tables.includes(table)) {
      throw new BadRequestException(
        `Metric '${dto.metric}' is not available for table '${table}'`,
      );
    }

    // Validate dimensions
    for (const dim of dto.groupBy) {
      if (!DIMENSIONS[dim]) {
        throw new BadRequestException(`Unknown dimension: ${dim}`);
      }
      if (!DIMENSIONS[dim].tables.includes(table)) {
        throw new BadRequestException(
          `Dimension '${dim}' is not available for table '${table}'`,
        );
      }
    }

    // Validate metricFilters
    for (const mf of dto.metricFilters || []) {
      if (!METRICS[mf.metric]) {
        throw new BadRequestException(`Unknown metric: ${mf.metric}`);
      }
      if (!METRICS[mf.metric].tables.includes(table)) {
        throw new BadRequestException(
          `Metric '${mf.metric}' is not available for table '${table}'`,
        );
      }
    }

    // Resolve date range from preset if needed
    const resolvedDateRange = { ...dto.dateRange };
    if (dto.dateRange.preset) {
      const resolved = resolveDatePreset(dto.dateRange.preset, tz);
      resolvedDateRange.start = resolved.start;
      resolvedDateRange.end = resolved.end;
    }

    // Convert ISO dates to ClickHouse format
    if (resolvedDateRange.start?.includes('T')) {
      resolvedDateRange.start = isoToClickHouseDateTime(
        resolvedDateRange.start,
      )!;
    }
    if (resolvedDateRange.end?.includes('T')) {
      resolvedDateRange.end = isoToClickHouseDateTime(resolvedDateRange.end)!;
    }

    // Build metric context from workspace settings
    const metricContext: MetricContext = {
      bounce_threshold: workspace.settings.bounce_threshold ?? 10,
    };

    // Build query with resolved dates
    const queryDto = { ...dto, dateRange: resolvedDateRange };
    const { sql, params } = buildExtremesQuery(queryDto, metricContext);

    // Execute query - result includes dimension columns for max row
    const result = await this.clickhouse.queryWorkspace<
      Record<string, unknown>
    >(dto.workspace_id, sql, params);

    const row = result[0] || {};

    // Extract dimension values from the result (all columns except min/max)
    const maxDimensionValues: Record<string, string | number | null> = {};
    for (const dim of dto.groupBy) {
      const dimDef = DIMENSIONS[dim];
      if (dimDef && row[dimDef.column] !== undefined) {
        maxDimensionValues[dim] = row[dimDef.column] as string | number | null;
      }
    }

    return {
      min: (row.min as number) ?? null,
      max: (row.max as number) ?? null,
      maxDimensionValues:
        Object.keys(maxDimensionValues).length > 0
          ? maxDimensionValues
          : undefined,
      meta: {
        metric: dto.metric,
        groupBy: dto.groupBy,
        dateRange: {
          start: resolvedDateRange.start!,
          end: resolvedDateRange.end!,
        },
      },
    };
  }

  /**
   * Funnel (tunnel de vente) : combien de sessions/visiteurs franchissent une
   * séquence ordonnée d'étapes (objectifs), avec les taux de passage N→N+1 et le
   * taux global. Filtrable par canal (channel/channel_group) via `filters`.
   * S'appuie sur ClickHouse `windowFunnel` sur la table durable `goals`.
   */
  async funnel(dto: FunnelQueryDto): Promise<FunnelResponse> {
    const workspace = await this.workspacesService.get(dto.workspace_id);
    const tz = dto.timezone || workspace.timezone || 'UTC';
    const unit = dto.unit === 'visitor' ? 'visitor' : 'session';

    // Resolve date range (preset → absolute) and normalize to ClickHouse format.
    const resolved = dto.dateRange.preset
      ? resolveDatePreset(dto.dateRange.preset, tz)
      : { start: dto.dateRange.start!, end: dto.dateRange.end! };
    const startCh = resolved.start.includes('T')
      ? isoToClickHouseDateTime(resolved.start)!
      : resolved.start;
    const endCh = resolved.end.includes('T')
      ? isoToClickHouseDateTime(resolved.end)!
      : resolved.end;

    // windowFunnel window: default = full span (steps may span the whole range).
    const spanSeconds = Math.max(
      1,
      Math.ceil(
        (new Date(resolved.end).getTime() -
          new Date(resolved.start).getTime()) /
          1000,
      ),
    );
    const windowSeconds = dto.window_seconds ?? spanSeconds;

    const { sql, params } = buildFunnelQuery({
      steps: dto.steps,
      start: startCh,
      end: endCh,
      unit,
      windowSeconds,
      filters: dto.filters,
    });

    const rows = await this.clickhouse.queryWorkspace<Record<string, unknown>>(
      dto.workspace_id,
      sql,
      params,
    );
    const row = rows[0] ?? {};

    // Coerce step counts (ClickHouse returns aggregates as strings).
    const counts = dto.steps.map((_, i) => {
      const v = row[`s${i}`];
      const n = typeof v === 'number' ? v : Number(v ?? 0);
      return Number.isFinite(n) ? n : 0;
    });

    const entered = counts[0] ?? 0;
    const steps: FunnelStepResult[] = dto.steps.map((s, i) => {
      const count = counts[i] ?? 0;
      const prev = i === 0 ? null : (counts[i - 1] ?? 0);
      const convFromPrev =
        prev === null ? null : prev > 0 ? round2((count / prev) * 100) : 0;
      const convFromStart = entered > 0 ? round2((count / entered) * 100) : 0;
      const dropoff = prev === null ? 0 : Math.max(0, prev - count);
      return {
        step: i + 1,
        goal_name: s.goal_name,
        label: s.label || s.goal_name,
        count,
        conversion_from_previous: convFromPrev,
        conversion_from_start: convFromStart,
        dropoff_from_previous: dropoff,
      };
    });

    const last = counts[counts.length - 1] ?? 0;
    const overall = entered > 0 ? round2((last / entered) * 100) : 0;

    return {
      workspace_id: dto.workspace_id,
      unit,
      dateRange: { start: startCh, end: endCh },
      entered,
      overall_conversion: overall,
      steps,
    };
  }

  /**
   * Taux de conversion par app × canal : pour chaque (channel_group, app), le
   * nombre de conversions (uniqExact(session_id) sur les goals du type ciblé) et
   * le taux = conversions(canal, app) / sessions(canal). Le dénominateur est le
   * total des sessions du canal (colonne UI "Sessions du canal"), compté en
   * uniqExact(id) pour être déterministe et cohérent avec le numérateur (les
   * deux dédupliquent par identité de session ; un mélange count()/uniqExact
   * donnait des chiffres faux et instables). Le taux d'une ligne = part des
   * sessions du canal converties vers cette app ; les taux des apps d'un même
   * canal ne sont pas exclusifs et ne s'additionnent donc pas à 100 %. Borné à
   * 100 % par sécurité. `app` provient de `properties['app']` porté par les goals
   * d'inscription (signup/app_started). Différenciateur "d'où viennent mes
   * clients, et sur quelle app".
   */
  async conversionsByChannel(dto: ConversionsByChannelDto): Promise<{
    workspace_id: string;
    dateRange: { start: string; end: string };
    conversion_goals: string[];
    rows: Array<{
      channel_group: string;
      app: string;
      conversions: number;
      sessions: number;
      conversion_rate: number;
    }>;
  }> {
    const workspace = await this.workspacesService.get(dto.workspace_id);
    const tz = dto.timezone || workspace.timezone || 'UTC';

    const resolved = dto.dateRange.preset
      ? resolveDatePreset(dto.dateRange.preset, tz)
      : { start: dto.dateRange.start!, end: dto.dateRange.end! };
    const startCh = resolved.start.includes('T')
      ? isoToClickHouseDateTime(resolved.start)!
      : resolved.start;
    const endCh = resolved.end.includes('T')
      ? isoToClickHouseDateTime(resolved.end)!
      : resolved.end;

    const goals =
      dto.conversion_goals && dto.conversion_goals.length > 0
        ? dto.conversion_goals
        : ['signup', 'app_started'];

    // Conversions per (channel_group, app) from the goals table.
    //
    // `AND session_id != ''` aligns the definition of "a conversion" with the
    // sales funnel (funnel-builder.ts applies the same guard in session mode):
    // a conversion is a *converted session*, identified by a non-empty
    // session_id. This makes funnel(goal) == sum(conversions(goal)) hold for
    // ANY data state, instead of diverging on orphan goals.
    //
    // Why this is safe (never drops a legitimate conversion): every goal carries
    // a non-empty session_id by construction — web goals belong to the visitor's
    // session, and server-to-server goals synthesize one (e.g. phone_call →
    // `voip:<provider>:<id>`, see voip/phone-call-event.ts). A goal with an
    // empty session_id is an orphan (transient ingestion anomaly) that must not
    // be counted as a converted session by either surface.
    const convRows = await this.clickhouse.queryWorkspace<{
      channel_group: string;
      app: string;
      conversions: string | number;
    }>(
      dto.workspace_id,
      `SELECT
         channel_group,
         properties['app'] AS app,
         uniqExact(session_id) AS conversions
       FROM goals
       WHERE goal_timestamp >= {start:DateTime64(3)}
         AND goal_timestamp <= {end:DateTime64(3)}
         AND goal_name IN ({goals:Array(String)})
         AND session_id != ''
       GROUP BY channel_group, app`,
      { start: startCh, end: endCh, goals },
    );

    // Sessions per channel_group (denominator). uniqExact(id), NOT count():
    // `sessions` is a ReplacingMergeTree(updated_at) and count() over FINAL is
    // non-deterministic until the async merge dedups duplicate rows (observed
    // direct: 1 -> 12 -> 14 between refreshes). uniqExact(id) dedups by session
    // identity at query time => stable denominator, and matches the numerator's
    // own uniqExact(session_id) dedup logic (count vs uniqExact mismatch was the
    // core defect). The denominator is the total sessions of the channel — the
    // console labels this column "Sessions du canal" explicitly. The rate per row
    // is conversions(channel, app) / sessions(channel): the share of the channel's
    // sessions that converted toward this app. Rates across apps of the same
    // channel are NOT mutually exclusive, so they are not meant to sum to <= 100%.
    const sessRows = await this.clickhouse.queryWorkspace<{
      channel_group: string;
      sessions: string | number;
    }>(
      dto.workspace_id,
      `SELECT channel_group, uniqExact(id) AS sessions
       FROM sessions FINAL
       WHERE created_at >= {start:DateTime64(3)}
         AND created_at <= {end:DateTime64(3)}
       GROUP BY channel_group`,
      { start: startCh, end: endCh },
    );

    const sessionsByChannel = new Map<string, number>();
    for (const r of sessRows) {
      sessionsByChannel.set(r.channel_group, Number(r.sessions ?? 0));
    }

    const rows = convRows.map((r) => {
      const conversions = Number(r.conversions ?? 0);
      const sessions = sessionsByChannel.get(r.channel_group) ?? 0;
      // Clamp at 100%: a conversion goal can carry a session_id whose session row
      // falls outside the date window (or was never materialized), so converted
      // sessions for an app can momentarily exceed the channel's session count.
      // A conversion rate > 100% is always a wrong number to show a client.
      const rate =
        sessions > 0 ? Math.min(round2((conversions / sessions) * 100), 100) : 0;
      return {
        channel_group: r.channel_group,
        app: r.app || '(non renseigné)',
        conversions,
        sessions,
        conversion_rate: rate,
      };
    });

    return {
      workspace_id: dto.workspace_id,
      dateRange: { start: startCh, end: endCh },
      conversion_goals: goals,
      rows,
    };
  }

  /**
   * Get cache TTL based on whether the date range includes today.
   * Live data (includes today) gets 1 min TTL, historical gets 5 min.
   */
  private getTTL(dates: { start: string; end: string }, tz: string): number {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    // Handle both ISO format (2025-01-05T...) and ClickHouse format (2025-01-05 ...)
    const endDate = dates.end.split(' ')[0].split('T')[0];
    return endDate >= today ? this.CACHE_TTL_LIVE : this.CACHE_TTL_HISTORICAL;
  }

  /**
   * Generate a cache key from query parameters.
   * Key is workspace-scoped and includes all query-affecting parameters.
   */
  private generateCacheKey(
    dto: AnalyticsQueryDto,
    dates: { start: string; end: string },
    tz: string,
  ): string {
    const parts = [
      dto.workspace_id,
      dto.table || 'sessions',
      [...dto.metrics].sort().join(','),
      [...(dto.dimensions || [])].sort().join(','),
      [...(dto.totalsGroupBy || [])].sort().join(','),
      dates.start,
      dates.end,
      dto.dateRange.granularity || '',
      tz,
      dto.limit || 1000,
      JSON.stringify(dto.filters || []),
      JSON.stringify(dto.metricFilters || []),
      JSON.stringify(dto.order || {}),
      dto.compareDateRange ? JSON.stringify(dto.compareDateRange) : '',
      dto.havingMinSessions || 0,
    ];
    const hash = crypto
      .createHash('sha256')
      .update(parts.join('|'))
      .digest('hex')
      .slice(0, 16);
    const key = `analytics:${dto.workspace_id}:${hash}`;

    // Track key for invalidation, with a hard per-workspace cap (oldest-first
    // eviction) so the Set never grows without bound — see
    // DEFAULT_CACHE_KEYS_MAX_PER_WORKSPACE.
    this.trackCacheKey(dto.workspace_id, key);

    return key;
  }

  /**
   * Record a cache key for later workspace-wide invalidation, bounded by a hard
   * per-workspace size cap. A Set preserves insertion order, so its first
   * element is the oldest. When the cap is reached we evict the oldest tracked
   * key AND drop its `cacheManager` entry, so the tracker and the cache stay
   * consistent (evicting from the Set alone would leave an entry that
   * `backfill.completed` could no longer invalidate — it would only expire by
   * TTL). The `cacheManager.del` is fire-and-forget: it must not block or throw
   * inside the synchronous query path.
   */
  private trackCacheKey(workspaceId: string, key: string): void {
    let keys = this.workspaceCacheKeys.get(workspaceId);
    if (!keys) {
      keys = new Set();
      this.workspaceCacheKeys.set(workspaceId, keys);
    }
    if (keys.size >= this.cacheKeysMaxPerWorkspace && !keys.has(key)) {
      const oldest = keys.values().next().value;
      if (oldest !== undefined) {
        keys.delete(oldest);
        void this.cacheManager.del(oldest).catch(() => undefined);
      }
    }
    keys.add(key);
  }

  /**
   * Handle backfill completion event.
   * Clears all cached queries for the workspace.
   */
  @OnEvent('backfill.completed')
  async handleBackfillCompleted(payload: { workspaceId: string }) {
    const keys = this.workspaceCacheKeys.get(payload.workspaceId);
    if (keys) {
      await Promise.all([...keys].map((k) => this.cacheManager.del(k)));
      this.workspaceCacheKeys.delete(payload.workspaceId);
      console.log(
        `Cleared ${keys.size} cached analytics queries for workspace ${payload.workspaceId}`,
      );
    }
  }
}
