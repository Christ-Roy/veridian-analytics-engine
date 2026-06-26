import {
  registerDecorator,
  ValidationOptions,
  ValidationArguments,
} from 'class-validator';
import {
  isWidgetSafeMetric,
  isWidgetSafeDimension,
  WIDGET_KINDS,
  WIDGET_GRANULARITIES,
  WIDGET_FILTER_OPERATORS,
  WIDGET_SAFE_METRICS,
  WIDGET_SAFE_DIMENSIONS,
  WidgetKind,
  WidgetTable,
} from '../widget-catalog';

/**
 * Closed list of configurable native dashboard widget keys (N3 layout).
 *
 * MUST stay in sync with the console source of truth
 * `console/src/components/dashboard/dashboard-layout.ts::DASHBOARD_WIDGET_KEYS`.
 * The front renders a fixed grid of native staminads widgets; `setLayout` only
 * REORDERS/HIDES these existing keys (no custom widget). An `order`/`hide` value
 * naming an unknown key used to be silently accepted (write 200, persisted) and
 * the front just ignored it → a typo'd `order` produced a silently broken layout
 * (ticket 2026-06-24-validation-currency-e164-layout-trous §3).
 *
 * Duplicated here (not imported) on purpose: the api/ package must not depend on
 * console/ source. 8 stable keys, changed maybe twice a year — a sync comment is
 * the right cost, not a build-time coupling.
 */
export const DASHBOARD_WIDGET_KEYS = [
  'pages',
  'sources',
  'campaigns',
  'countries',
  'heatmap',
  'devices',
  'page_views',
  'goals',
] as const;

export type DashboardWidgetKey = (typeof DASHBOARD_WIDGET_KEYS)[number];

const WIDGET_KEY_SET = new Set<string>(DASHBOARD_WIDGET_KEYS);

/** True if `value` is a known native dashboard widget key. */
export function isKnownDashboardWidget(value: unknown): boolean {
  return typeof value === 'string' && WIDGET_KEY_SET.has(value);
}

/**
 * Array-element decorator rejecting any unknown dashboard widget key. Apply with
 * `{ each: true }` on `order` / `hidden_widgets`. Lists the valid keys in the
 * error so the M2M caller gets an actionable 400 instead of a silent broken
 * layout.
 */
export function IsKnownDashboardWidget(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: 'isKnownDashboardWidget',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isKnownDashboardWidget(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `each value in ${args.property} must be a known dashboard widget (one of: ${DASHBOARD_WIDGET_KEYS.join(', ')})`;
        },
      },
    });
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Custom widget config (VAGUE 2 — dashboard customisable "comme Twenty").
//
// On top of REORDER/HIDE-ing the 8 native widgets, a workspace can DEFINE custom
// widgets stored in `dashboard_layout.widgets[]`. Each widget is a DESCRIPTION of
// a group-by (`{kind, metric, table, dimension, granularity, filters}`) that the
// engine compiles into the canonical AnalyticsQueryDto and resolves through the
// EXISTING query-builder (zero new query path). The native widgets are untouched.
//
// Garde-fou (arbitrage lead 2026-06-26): VALIDATION STRICTE AU setLayout — a
// widget that references an unknown/forbidden metric or dimension, or whose kind
// is incoherent (dimension_table without a dimension, metric_card WITH one,
// time_series without a granularity), is REJECTED at persist time (400) and never
// stored. The whitelist (widget-catalog.json) is intentionally narrower than the
// full METRICS/DIMENSIONS: identifiers (user_id/visitor_id/fingerprint) and noisy
// per-session numerics are excluded by construction.
// ───────────────────────────────────────────────────────────────────────────

/** Allowed `table` values for a custom widget (mirrors ANALYTICS_TABLES). */
const WIDGET_TABLES: readonly WidgetTable[] = ['sessions', 'pages', 'goals'];

/** A slug is a lowercase alnum id with single dashes/underscores, 1–64 chars. */
const WIDGET_ID_RE = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

export interface WidgetFilterInput {
  dimension?: unknown;
  operator?: unknown;
  values?: unknown;
}

export interface WidgetConfigInput {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  metric?: unknown;
  table?: unknown;
  dimension?: unknown;
  granularity?: unknown;
  filters?: unknown;
  limit?: unknown;
}

/** Operators that take no `values` array (presence/absence checks). */
const NO_VALUE_OPERATORS = new Set([
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
]);

/**
 * Validate ONE widget config in isolation. Returns an array of human-readable
 * error strings (empty = valid). Pure + synchronous so it can run both at
 * setLayout (persist gate) and as a defensive re-check at widgetData compile.
 *
 * `table` defaults to 'sessions' when omitted (same default as the query-builder
 * and AnalyticsQueryDto), so metric/dimension availability is checked against the
 * effective table.
 */
export function validateWidgetConfig(w: WidgetConfigInput): string[] {
  const errors: string[] = [];

  // id — required, unique slug (uniqueness checked by the caller across the set)
  if (typeof w.id !== 'string' || !WIDGET_ID_RE.test(w.id)) {
    errors.push(
      `widget.id must be a slug (lowercase alphanumeric, dashes/underscores, 1-64 chars), got ${JSON.stringify(w.id)}`,
    );
  }

  // kind — required, one of the 3 validated kinds
  const kind = w.kind as WidgetKind;
  if (typeof kind !== 'string' || !WIDGET_KINDS.includes(kind)) {
    errors.push(
      `widget.kind must be one of: ${WIDGET_KINDS.join(', ')}, got ${JSON.stringify(w.kind)}`,
    );
  }

  // title — required, non-empty, bounded
  if (
    typeof w.title !== 'string' ||
    w.title.trim().length === 0 ||
    w.title.length > 120
  ) {
    errors.push('widget.title must be a non-empty string (max 120 chars)');
  }

  // table — optional, defaults to sessions
  let table: WidgetTable = 'sessions';
  if (w.table !== undefined) {
    if (
      typeof w.table !== 'string' ||
      !WIDGET_TABLES.includes(w.table as WidgetTable)
    ) {
      errors.push(
        `widget.table must be one of: ${WIDGET_TABLES.join(', ')}, got ${JSON.stringify(w.table)}`,
      );
    } else {
      table = w.table as WidgetTable;
    }
  }

  // metric — required, widget-safe, available on the (effective) table
  if (typeof w.metric !== 'string') {
    errors.push('widget.metric is required and must be a string');
  } else if (!isWidgetSafeMetric(w.metric, table)) {
    errors.push(
      `widget.metric '${w.metric}' is not a widget-safe metric for table '${table}' (allowed: ${WIDGET_SAFE_METRICS.join(', ')})`,
    );
  }

  // dimension presence rules per kind + whitelist
  const hasDimension = w.dimension !== undefined && w.dimension !== null;
  if (kind === 'dimension_table') {
    if (!hasDimension) {
      errors.push("widget.dimension is required for kind 'dimension_table'");
    }
  } else if (hasDimension) {
    // metric_card and time_series must NOT carry a dimension (no group-by).
    errors.push(
      `widget.dimension must be omitted for kind '${typeof kind === 'string' ? kind : 'unknown'}'`,
    );
  }
  if (hasDimension) {
    if (typeof w.dimension !== 'string') {
      errors.push('widget.dimension must be a string');
    } else if (!isWidgetSafeDimension(w.dimension, table)) {
      errors.push(
        `widget.dimension '${w.dimension}' is not a widget-safe dimension for table '${table}' (allowed: ${WIDGET_SAFE_DIMENSIONS.join(', ')})`,
      );
    }
  }

  // granularity rules per kind
  const hasGranularity = w.granularity !== undefined && w.granularity !== null;
  if (kind === 'time_series') {
    if (!hasGranularity) {
      errors.push("widget.granularity is required for kind 'time_series'");
    }
  } else if (hasGranularity) {
    errors.push(
      `widget.granularity must be omitted for kind '${typeof kind === 'string' ? kind : 'unknown'}'`,
    );
  }
  if (
    hasGranularity &&
    (typeof w.granularity !== 'string' ||
      !WIDGET_GRANULARITIES.includes(w.granularity))
  ) {
    errors.push(
      `widget.granularity must be one of: ${WIDGET_GRANULARITIES.join(', ')}, got ${JSON.stringify(w.granularity)}`,
    );
  }

  // limit — optional, 1..1000 (cap dimension_table rows; query-builder caps 10000)
  if (w.limit !== undefined) {
    if (
      typeof w.limit !== 'number' ||
      !Number.isInteger(w.limit) ||
      w.limit < 1 ||
      w.limit > 1000
    ) {
      errors.push('widget.limit must be an integer between 1 and 1000');
    }
  }

  // filters — optional array of {dimension (widget-safe), operator, values}
  if (w.filters !== undefined) {
    if (!Array.isArray(w.filters)) {
      errors.push('widget.filters must be an array');
    } else {
      w.filters.forEach((f: WidgetFilterInput, i: number) => {
        if (typeof f !== 'object' || f === null) {
          errors.push(`widget.filters[${i}] must be an object`);
          return;
        }
        if (
          typeof f.dimension !== 'string' ||
          !isWidgetSafeDimension(f.dimension, table)
        ) {
          errors.push(
            `widget.filters[${i}].dimension '${String(f.dimension)}' is not a widget-safe dimension for table '${table}'`,
          );
        }
        if (
          typeof f.operator !== 'string' ||
          !WIDGET_FILTER_OPERATORS.includes(f.operator)
        ) {
          errors.push(
            `widget.filters[${i}].operator must be one of: ${WIDGET_FILTER_OPERATORS.join(', ')}`,
          );
        } else if (!NO_VALUE_OPERATORS.has(f.operator)) {
          if (
            !Array.isArray(f.values) ||
            f.values.length === 0 ||
            f.values.length > 100
          ) {
            errors.push(
              `widget.filters[${i}].values must be a non-empty array (max 100) for operator '${f.operator}'`,
            );
          }
        }
      });
    }
  }

  return errors;
}

/**
 * Validate the whole `widgets[]` array of a layout: each widget individually +
 * cross-widget id uniqueness + a hard cap on the number of widgets. Returns a
 * flat list of error strings (empty = valid). Caller maps a non-empty result to
 * a 400 and NEVER persists the layout.
 */
export const MAX_CUSTOM_WIDGETS = 50;

export function validateWidgetsArray(widgets: unknown): string[] {
  if (widgets === undefined || widgets === null) return [];
  if (!Array.isArray(widgets)) {
    return ['dashboard_layout.widgets must be an array'];
  }
  if (widgets.length > MAX_CUSTOM_WIDGETS) {
    return [
      `dashboard_layout.widgets must not exceed ${MAX_CUSTOM_WIDGETS} widgets (got ${widgets.length})`,
    ];
  }
  const errors: string[] = [];
  const seen = new Set<string>();
  widgets.forEach((w: WidgetConfigInput, i: number) => {
    const wErrors = validateWidgetConfig(w);
    wErrors.forEach((e) => errors.push(`widgets[${i}]: ${e}`));
    if (typeof w.id === 'string') {
      if (seen.has(w.id)) {
        errors.push(`widgets[${i}]: duplicate widget id '${w.id}'`);
      }
      seen.add(w.id);
    }
  });
  return errors;
}
