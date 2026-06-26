/**
 * Logique PURE (testable) des widgets dashboard custom (VAGUE 2 — « comme
 * Twenty »). Aucune dépendance React ici : compilation config → requête
 * analytics + extraction des données de rendu. Le composant React
 * (`CustomWidget.tsx`) consomme ces fonctions.
 *
 * ── Pourquoi le front compile lui-même au lieu d'appeler `analytics.widgetData` ──
 * L'endpoint M2M `POST /api/admin/platform/analytics.widgetData` (livré par
 * l'agent backend) est gardé par `PlatformAdminGuard` (Bearer
 * PLATFORM_ADMIN_API_KEY) : la console, authentifiée en JWT utilisateur, ne peut
 * PAS l'atteindre. On reproduit donc EXACTEMENT la même compilation que le
 * backend (admin-platform.service.ts widgetData) mais on délègue à l'endpoint
 * UTILISATEUR `analytics.query` (même `analyticsService.query()` derrière), pour
 * lequel la console est déjà autorisée. La config widget est l'AUTORITÉ
 * (metric/dimension/granularity/filters viennent du config STORED, déjà validé
 * strictement à la persistance côté engine), le front n'invente rien.
 */
import { toMetricNumber } from '../../lib/dimension-utils'
import { widgetMetricFormat } from './widget-catalog'
import type {
  AnalyticsQuery,
  AnalyticsResponse,
  DateRange,
  Filter,
  FilterOperator,
  Granularity,
} from '../../types/analytics'
import type { ChartDataPoint } from '../../types/dashboard'
import type { DashboardWidget } from '../../types/workspace'

/** Colonne de date renvoyée par ClickHouse selon la granularité. */
const GRANULARITY_DATE_COLUMN: Record<Granularity, string> = {
  hour: 'date_hour',
  day: 'date_day',
  week: 'date_week',
  month: 'date_month',
  year: 'date_year',
}

export interface CompileContext {
  workspaceId: string
  /** Plage courante du dashboard (preset OU start+end). */
  dateRange: DateRange
  timezone: string
  /** Filtres globaux du dashboard, combinés aux filtres du widget. */
  globalFilters: Filter[]
}

/**
 * Compile un widget custom en `AnalyticsQuery` pour l'endpoint utilisateur
 * `analytics.query`. Reproduit la logique backend (widgetData) :
 *  - dimension_table groupe par la (seule) dimension ; les autres non
 *  - time_series bucketise par la granularité du widget (autorité config)
 *  - dimension_table plafonne ses lignes (défaut 10) ; les autres → 1 ligne
 *  - filtres du config + filtres globaux du dashboard
 *
 * Le widget est supposé déjà valide (validé à la persistance côté engine). On
 * ne refait pas la validation whitelist ici : le rendu se dégrade proprement si
 * la donnée manque (cf. extract*).
 */
export function compileWidgetQuery(
  widget: DashboardWidget,
  ctx: CompileContext,
): AnalyticsQuery {
  const table = widget.table ?? 'sessions'
  const isTimeSeries = widget.kind === 'time_series'
  const isDimensionTable = widget.kind === 'dimension_table'

  // Filtres du widget mappés au shape natif, fusionnés aux filtres globaux.
  // Le filtre widget prime sur un filtre global de même dimension.
  const widgetFilters: Filter[] = (widget.filters ?? []).map((f) => ({
    dimension: f.dimension,
    operator: f.operator as FilterOperator,
    values: f.values,
  }))
  const widgetDims = new Set(widgetFilters.map((f) => f.dimension))
  const mergedFilters: Filter[] = [
    ...ctx.globalFilters.filter((gf) => !widgetDims.has(gf.dimension)),
    ...widgetFilters,
  ]

  const dateRange: DateRange = {
    ...ctx.dateRange,
    // La granularité du config fait autorité pour time_series ; sinon aucune
    // (agrégat sur toute la période → 1 ligne).
    granularity: isTimeSeries ? (widget.granularity as Granularity) : undefined,
  }

  return {
    workspace_id: ctx.workspaceId,
    table,
    metrics: [widget.metric],
    dimensions: widget.dimension ? [widget.dimension] : [],
    filters: mergedFilters.length > 0 ? mergedFilters : undefined,
    dateRange,
    // dimension_table : tri décroissant sur la métrique pour un top-N lisible.
    ...(isDimensionTable ? { order: { [widget.metric]: 'desc' } } : {}),
    limit: isDimensionTable ? (widget.limit ?? 10) : undefined,
    timezone: ctx.timezone,
  }
}

/** Lit les lignes brutes d'une réponse analytics (toujours non-comparée ici). */
function rows(response: AnalyticsResponse | undefined): Record<string, unknown>[] {
  if (!response?.data) return []
  if (Array.isArray(response.data)) return response.data
  // Sécurité : si jamais une réponse comparée arrivait, on prend `current`.
  const maybe = response.data as { current?: Record<string, unknown>[] }
  return Array.isArray(maybe.current) ? maybe.current : []
}

/**
 * metric_card : extrait la valeur agrégée unique (1ʳᵉ ligne, colonne = métrique).
 * Renvoie 0 si pas de donnée (fail-safe, jamais NaN/undefined à l'UI).
 */
export function extractMetricCardValue(
  widget: DashboardWidget,
  response: AnalyticsResponse | undefined,
): number {
  const r = rows(response)
  if (r.length === 0) return 0
  return toMetricNumber(r[0][widget.metric]) ?? 0
}

/**
 * time_series : extrait les points {timestamp, value}. Le timestamp lit la
 * colonne de date correspondant à la granularité du widget (fallback : 1ʳᵉ
 * colonne `date_*` trouvée, comme le dashboard natif).
 */
export function extractTimeSeriesPoints(
  widget: DashboardWidget,
  response: AnalyticsResponse | undefined,
): ChartDataPoint[] {
  const r = rows(response)
  if (r.length === 0) return []
  const expected = widget.granularity
    ? GRANULARITY_DATE_COLUMN[widget.granularity as Granularity]
    : 'date_day'
  const dateColumn = findDateColumn(r[0], expected)
  return r.map((row) => ({
    timestamp: String(row[dateColumn] ?? ''),
    value: toMetricNumber(row[widget.metric]) ?? 0,
  }))
}

export interface DimensionTableRow {
  dimension_value: string
  value: number
}

/**
 * dimension_table : extrait les lignes {dimension_value, value} triées comme
 * renvoyées par l'API (déjà ordonnées desc sur la métrique).
 */
export function extractDimensionRows(
  widget: DashboardWidget,
  response: AnalyticsResponse | undefined,
): DimensionTableRow[] {
  const r = rows(response)
  if (r.length === 0 || !widget.dimension) return []
  const dim = widget.dimension
  return r.map((row) => ({
    dimension_value: row[dim] === null || row[dim] === undefined ? '' : String(row[dim]),
    value: toMetricNumber(row[widget.metric]) ?? 0,
  }))
}

/** Le format d'affichage de la métrique du widget (number/duration/…). */
export function widgetFormat(
  widget: DashboardWidget,
): 'number' | 'duration' | 'percentage' | 'currency' {
  return widgetMetricFormat(widget.metric)
}

/** Granularités de moins d'1 colonne date : retrouve la colonne réellement présente. */
const DATE_COLUMNS = ['date_hour', 'date_day', 'date_week', 'date_month', 'date_year']
function findDateColumn(row: Record<string, unknown>, expected: string): string {
  if (row[expected] !== undefined) return expected
  for (const col of DATE_COLUMNS) {
    if (row[col] !== undefined) return col
  }
  return expected
}
