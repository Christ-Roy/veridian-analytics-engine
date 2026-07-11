export const FILTER_OPERATORS = [
  'equals',
  'notEquals',
  'in',
  'notIn',
  'contains',
  'notContains',
  'gt',
  'gte',
  'lt',
  'lte',
  'isNull',
  'isNotNull',
  'between',
  'isEmpty',
  'isNotEmpty',
] as const

export type FilterOperator = (typeof FILTER_OPERATORS)[number]

export const GRANULARITIES = ['hour', 'day', 'week', 'month', 'year'] as const
export type Granularity = (typeof GRANULARITIES)[number]

export const DATE_PRESETS = [
  'previous_30_minutes',
  'today',
  'yesterday',
  'previous_7_days',
  'previous_14_days',
  'previous_28_days',
  'previous_30_days',
  'previous_90_days',
  'previous_91_days',
  'this_week',
  'previous_week',
  'this_month',
  'previous_month',
  'this_quarter',
  'previous_quarter',
  'this_year',
  'previous_year',
  'previous_12_months',
  'all_time',
  'custom',
] as const

export type DatePreset = (typeof DATE_PRESETS)[number]

export interface Filter {
  dimension: string
  operator: FilterOperator
  values?: (string | number | null)[]
}

export const METRIC_FILTER_OPERATORS = ['gt', 'gte', 'lt', 'lte', 'between'] as const
export type MetricFilterOperator = (typeof METRIC_FILTER_OPERATORS)[number]

export interface MetricFilter {
  metric: string
  operator: MetricFilterOperator
  values: (number | null)[]
}

export interface DateRange {
  start?: string
  end?: string
  preset?: DatePreset
  granularity?: Granularity
}

export type AnalyticsTable = 'sessions' | 'pages' | 'goals'

export interface AnalyticsQuery {
  workspace_id: string
  table?: AnalyticsTable
  metrics: string[]
  dimensions?: string[]
  filters?: Filter[]
  metricFilters?: MetricFilter[]
  dateRange: DateRange
  compareDateRange?: DateRange
  timezone?: string
  order?: Record<string, 'asc' | 'desc'>
  limit?: number
  havingMinSessions?: number
  /** When set with metricFilters, enables filtered totals via subquery */
  totalsGroupBy?: string[]
}

export interface AnalyticsResponse {
  data: Record<string, unknown>[] | { current: Record<string, unknown>[]; previous: Record<string, unknown>[] }
  meta: {
    metrics: string[]
    dimensions: string[]
    granularity?: string
    dateRange: { start: string; end: string }
    compareDateRange?: { start: string; end: string }
    total_rows: number
  }
  query: {
    sql: string
    params: Record<string, unknown>
  }
}

export interface MetricDefinition {
  name: string
  description: string
}

export interface DimensionDefinition {
  name: string
  type: 'string' | 'number' | 'boolean'
  category: string
}

export interface FunnelStep {
  goal_name: string
  label?: string
}

export interface FunnelQuery {
  workspace_id: string
  steps: FunnelStep[]
  dateRange: DateRange
  filters?: Filter[]
  timezone?: string
  unit?: 'session' | 'visitor'
  window_seconds?: number
  /**
   * Dimension de segmentation (ex : `'variant'` pour comparer A/B/C). Quand
   * fournie, l'API renvoie `FunnelSegmentedResponse` (une série par valeur) au
   * lieu de `FunnelResponse`. Le back garde-fou à SEGMENT_MAX (12) séries.
   */
  segment_by?: string
}

export interface FunnelStepResult {
  step: number
  goal_name: string
  label: string
  count: number
  /** Valeur € cumulée des goals de cette étape (A3-value, `sumIf(goal_value)`). */
  value: number
  conversion_from_previous: number | null
  conversion_from_start: number
  dropoff_from_previous: number
}

export interface FunnelResponse {
  workspace_id: string
  unit: 'session' | 'visitor'
  dateRange: { start: string; end: string }
  entered: number
  overall_conversion: number
  steps: FunnelStepResult[]
}

/**
 * Une série (un mini-funnel complet) pour une valeur de la dimension de
 * segmentation. Miroir du contrat backend `FunnelSegment`.
 */
export interface FunnelSegment {
  /** Valeur brute de la dimension (ex : 'A', 'desktop'). */
  key: string
  /** Libellé affiché (= key par défaut ; le front peut mapper). */
  label: string
  entered: number
  overall_conversion: number
  steps: FunnelStepResult[]
}

/**
 * Réponse multi-séries — renvoyée UNIQUEMENT quand `segment_by` est fourni. Le
 * consommateur discrimine sur la présence de `segments`/`segment_by`.
 */
export interface FunnelSegmentedResponse {
  workspace_id: string
  unit: 'session' | 'visitor'
  dateRange: { start: string; end: string }
  segment_by: string
  /** Une série par valeur distincte, triée par `entered` desc. */
  segments: FunnelSegment[]
}

/** Union renvoyée par `analytics.funnel` selon la présence de `segment_by`. */
export type FunnelResult = FunnelResponse | FunnelSegmentedResponse

/** Discriminant : la réponse est-elle segmentée (multi-séries) ? */
export function isFunnelSegmented(
  r: FunnelResult,
): r is FunnelSegmentedResponse {
  return 'segments' in r && Array.isArray((r as FunnelSegmentedResponse).segments)
}

export interface ConversionsByChannelQuery {
  workspace_id: string
  dateRange: DateRange
  conversion_goals?: string[]
  timezone?: string
}

export interface ConversionsByChannelRow {
  channel_group: string
  app: string
  conversions: number
  sessions: number
  conversion_rate: number
}

export interface ConversionsByChannelResponse {
  workspace_id: string
  dateRange: { start: string; end: string }
  conversion_goals: string[]
  rows: ConversionsByChannelRow[]
}

export interface ExtremesQuery {
  workspace_id: string
  metric: string
  groupBy: string[]
  dateRange: DateRange
  filters?: Filter[]
  metricFilters?: MetricFilter[]
  timezone?: string
  havingMinSessions?: number
}

export interface ExtremesResponse {
  min: number | null
  max: number | null
  maxDimensionValues?: Record<string, string | number | null>
  meta: {
    metric: string
    groupBy: string[]
    dateRange: { start: string; end: string }
  }
}
