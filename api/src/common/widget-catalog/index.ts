/**
 * Widget-safe catalogue — typed loader over the single shared JSON source
 * (`widget-catalog.json`). The JSON is the SOURCE UNIQUE consumed by BOTH the
 * API (setLayout validation + widgetData compilation) and the console A2 widget
 * builder (which imports the JSON directly). This module is just the typed,
 * lookup-friendly view of it for the backend.
 *
 * The catalogue is a DELIBERATELY RESTRICTED whitelist: only the metrics /
 * dimensions safe to expose as a custom dashboard widget. High-cardinality /
 * sensitive identifiers (user_id, visitor_id, fingerprint) and noisy per-session
 * numerics (lat/long, screen_*, viewport_*, duration, pageview_count) are
 * EXCLUDED by construction — they are not in the JSON. A custom widget can never
 * reference them, even though the underlying query-builder technically knows the
 * `user_id` dimension (used internally by prospect360, never by a client widget).
 */
import catalog from './widget-catalog.json';
import type { AnalyticsTable } from '../../analytics/constants/tables';

export type WidgetKind = 'metric_card' | 'time_series' | 'dimension_table';
export type WidgetTable = AnalyticsTable; // 'sessions' | 'pages' | 'goals'

interface CatalogEntry {
  label: string;
  tables: string[];
}

const METRICS_CATALOG = catalog.metrics as Record<string, CatalogEntry>;
const DIMENSIONS_CATALOG = catalog.dimensions as Record<string, CatalogEntry>;

export const WIDGET_KINDS = catalog.kinds as readonly WidgetKind[];
export const WIDGET_GRANULARITIES = catalog.granularities as readonly string[];
export const WIDGET_FILTER_OPERATORS =
  catalog.filterOperators as readonly string[];

/** All metric keys exposable in a widget (whitelist). */
export const WIDGET_SAFE_METRICS = Object.keys(METRICS_CATALOG);
/** All dimension keys exposable in a widget (whitelist). */
export const WIDGET_SAFE_DIMENSIONS = Object.keys(DIMENSIONS_CATALOG);

/** True when `metric` is widget-safe AND available on `table`. */
export function isWidgetSafeMetric(
  metric: string,
  table: WidgetTable,
): boolean {
  const entry = METRICS_CATALOG[metric];
  return !!entry && entry.tables.includes(table);
}

/** True when `dimension` is widget-safe AND available on `table`. */
export function isWidgetSafeDimension(
  dimension: string,
  table: WidgetTable,
): boolean {
  const entry = DIMENSIONS_CATALOG[dimension];
  return !!entry && entry.tables.includes(table);
}

/** True when `metric` is in the widget whitelist (any table). */
export function isWidgetSafeMetricAnyTable(metric: string): boolean {
  return !!METRICS_CATALOG[metric];
}

/** True when `dimension` is in the widget whitelist (any table). */
export function isWidgetSafeDimensionAnyTable(dimension: string): boolean {
  return !!DIMENSIONS_CATALOG[dimension];
}

export { catalog as WIDGET_CATALOG };
