/**
 * Catalogue widget-safe côté console — vue typée sur la SOURCE UNIQUE partagée
 * (`api/src/common/widget-catalog/widget-catalog.json`).
 *
 * Ce JSON est le catalogue de référence consommé par le BACKEND (validation
 * `setLayout` + compilation `widgetData`) ET par la console (ce module). On
 * l'importe directement plutôt que de redupliquer les clés des deux côtés —
 * c'est le « smell » que la VAGUE 2 résout. L'import cross-package est déjà un
 * pattern établi du repo (`console/vite.config.ts` importe `../api/src/version`).
 *
 * Liste DÉLIBÉRÉMENT RESTREINTE : seules les métriques/dimensions sûres à
 * exposer en widget. user_id / visitor_id / fingerprint en sont EXCLUS par
 * construction (absents du JSON) — un widget custom ne peut jamais les viser.
 */
import catalog from '../../../../api/src/common/widget-catalog/widget-catalog.json'

export type WidgetKind = 'metric_card' | 'time_series' | 'dimension_table'
export type WidgetTable = 'sessions' | 'pages' | 'goals'

interface CatalogEntry {
  label: string
  tables: string[]
}

const METRICS_CATALOG = catalog.metrics as Record<string, CatalogEntry>
const DIMENSIONS_CATALOG = catalog.dimensions as Record<string, CatalogEntry>

export const WIDGET_KINDS = catalog.kinds as readonly WidgetKind[]
export const WIDGET_GRANULARITIES = catalog.granularities as readonly string[]
export const WIDGET_FILTER_OPERATORS =
  catalog.filterOperators as readonly string[]

/** Toutes les métriques exposables en widget (whitelist). */
export const WIDGET_SAFE_METRICS = Object.keys(METRICS_CATALOG)
/** Toutes les dimensions exposables en widget (whitelist). */
export const WIDGET_SAFE_DIMENSIONS = Object.keys(DIMENSIONS_CATALOG)

/** Libellé français d'une métrique widget-safe (fallback = la clé brute). */
export function widgetMetricLabel(metric: string): string {
  return METRICS_CATALOG[metric]?.label ?? metric
}

/** Libellé français d'une dimension widget-safe (fallback = la clé brute). */
export function widgetDimensionLabel(dimension: string): string {
  return DIMENSIONS_CATALOG[dimension]?.label ?? dimension
}

/** `metric` est-elle widget-safe ? (toutes tables confondues) */
export function isWidgetSafeMetric(metric: string): boolean {
  return !!METRICS_CATALOG[metric]
}

/** `dimension` est-elle widget-safe ? (toutes tables confondues) */
export function isWidgetSafeDimension(dimension: string): boolean {
  return !!DIMENSIONS_CATALOG[dimension]
}

/**
 * Format d'affichage d'une métrique côté console. Le backend ne stocke pas de
 * `format` sur ses définitions de métriques (cf. api/src/analytics/constants/
 * metrics.ts) : on le dérive ici de la clé, comme le fait déjà `METRICS` natif
 * (types/dashboard.ts). Garder synchro si une métrique widget-safe est ajoutée.
 */
export function widgetMetricFormat(
  metric: string,
): 'number' | 'duration' | 'percentage' | 'currency' {
  if (metric.endsWith('_rate') || metric.endsWith('_scroll')) return 'percentage'
  if (metric.endsWith('_duration')) return 'duration'
  if (metric.endsWith('_value')) return 'currency'
  return 'number'
}

export { catalog as WIDGET_CATALOG }
