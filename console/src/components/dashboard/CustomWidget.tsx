import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Card, Empty, Alert } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { analyticsQueryOptions } from '../../lib/queries'
import { formatValue, formatCurrency } from '../../lib/chart-utils'
import { EMPTY_VALUE_LABEL } from '../../lib/explore-utils'
import { MetricChart } from './MetricChart'
import {
  compileWidgetQuery,
  extractMetricCardValue,
  extractTimeSeriesPoints,
  extractDimensionRows,
  widgetFormat,
  type CompileContext,
  type DimensionTableRow,
} from './custom-widget'
import { widgetMetricLabel } from './widget-catalog'
import type { MetricConfig } from '../../types/dashboard'
import type { Granularity } from '../../types/analytics'
import type { DashboardWidget } from '../../types/workspace'

type WidgetFormat = ReturnType<typeof widgetFormat>

/** Formate une valeur de widget selon son format (la devise vient du workspace). */
function formatWidgetValue(
  value: number,
  format: WidgetFormat,
  currency: string,
): string {
  if (format === 'currency') return formatCurrency(value, currency)
  // formatValue gère number/duration/percentage (pas currency).
  return formatValue(value, format as MetricConfig['format'])
}

/** Carte « titre + info ». Coquille commune aux 3 kinds, look natif staminads. */
function WidgetShell({
  title,
  children,
  bodyClass = '',
}: {
  title: string
  children: React.ReactNode
  bodyClass?: string
}) {
  return (
    <Card className="shadow-sm h-full" styles={{ body: { padding: '16px' } }}>
      <div className="text-sm font-medium text-gray-600 mb-3">{title}</div>
      <div className={bodyClass}>{children}</div>
    </Card>
  )
}

/** Squelette de chargement, hauteur alignée sur les widgets natifs. */
function WidgetSkeleton({ title }: { title: string }) {
  return (
    <WidgetShell title={title}>
      <div className="animate-pulse bg-gray-100 rounded" style={{ height: 180 }} />
    </WidgetShell>
  )
}

/* ── metric_card : une valeur agrégée unique ─────────────────────────────── */
function MetricCardWidget({
  widget,
  value,
  currency,
}: {
  widget: DashboardWidget
  value: number
  currency: string
}) {
  const format = widgetFormat(widget)
  return (
    <WidgetShell title={widget.title}>
      <div
        className="flex flex-col items-start justify-center"
        style={{ minHeight: 180 }}
        data-testid="custom-metric-card"
      >
        <div className="text-4xl font-light text-gray-800">
          {formatWidgetValue(value, format, currency)}
        </div>
        <div className="text-xs text-gray-400 mt-2">
          {widgetMetricLabel(widget.metric)}
        </div>
      </div>
    </WidgetShell>
  )
}

/* ── time_series : courbe temporelle (réutilise MetricChart natif) ────────── */
function TimeSeriesWidget({
  widget,
  dateRange,
  granularity,
  response,
  timezone,
}: {
  widget: DashboardWidget
  dateRange: { start: string; end: string }
  granularity: Granularity
  response: Parameters<typeof extractTimeSeriesPoints>[1]
  timezone: string
}) {
  const points = extractTimeSeriesPoints(widget, response)
  // MetricChart ne connaît pas le format 'currency' (axe = nombre brut). On le
  // rabat sur 'number' pour la courbe ; le formatage devise reste réservé aux
  // metric_card / dimension_table.
  const wFormat = widgetFormat(widget)
  const chartFormat: MetricConfig['format'] =
    wFormat === 'currency' ? 'number' : wFormat
  const metric: MetricConfig = {
    key: 'sessions', // clé technique non lue par MetricChart (utilise format/color/label)
    label: widget.title,
    format: chartFormat,
    color: '#7763f1',
    previousColor: '#9ca3af',
  }
  return (
    <WidgetShell title={widget.title}>
      <div data-testid="custom-time-series">
        <MetricChart
          metric={metric}
          currentData={points}
          previousData={[]}
          granularity={granularity}
          dateRange={dateRange}
          compareDateRange={{ start: '', end: '' }}
          height={200}
          timezone={timezone}
        />
      </div>
    </WidgetShell>
  )
}

/* ── dimension_table : top-N {dimension, métrique} avec barres ────────────── */
function DimensionTableWidgetCustom({
  widget,
  rows,
  currency,
}: {
  widget: DashboardWidget
  rows: DimensionTableRow[]
  currency: string
}) {
  const format = widgetFormat(widget)
  const max = rows.reduce((m, r) => Math.max(m, r.value), 0) || 1
  return (
    <WidgetShell title={widget.title}>
      {rows.length === 0 ? (
        <div className="flex items-center justify-center" style={{ height: 180 }}>
          <Empty description="Aucune donnée disponible" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      ) : (
        <div data-testid="custom-dimension-table" className="space-y-1">
          {rows.map((row, i) => (
            <div key={`${row.dimension_value}-${i}`} className="relative flex items-center justify-between py-1.5 px-2 text-sm">
              <div
                className="absolute inset-y-0 left-0 bg-indigo-50 rounded"
                style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
                aria-hidden
              />
              <span className="relative truncate text-gray-700 pr-3">
                {row.dimension_value === '' ? EMPTY_VALUE_LABEL : row.dimension_value}
              </span>
              <span className="relative font-medium text-gray-800 tabular-nums">
                {formatWidgetValue(row.value, format, currency)}
              </span>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  )
}

/**
 * REGISTRE `widgetKind → composant` (le pattern « comme Twenty » volé : nos
 * widgets ne sont plus un array figé, ils sont adressables par clé). Un kind
 * absent du registre → on ne crashe pas la grille (cf. CustomWidget plus bas).
 */
export const WIDGET_RENDERERS: Record<
  DashboardWidget['kind'],
  (props: WidgetRenderProps) => React.ReactNode
> = {
  metric_card: ({ widget, response, currency }) => (
    <MetricCardWidget
      widget={widget}
      value={extractMetricCardValue(widget, response)}
      currency={currency}
    />
  ),
  time_series: ({ widget, response, dateRange, granularity, timezone }) => (
    <TimeSeriesWidget
      widget={widget}
      response={response}
      dateRange={dateRange}
      granularity={granularity}
      timezone={timezone}
    />
  ),
  dimension_table: ({ widget, response, currency }) => (
    <DimensionTableWidgetCustom
      widget={widget}
      rows={extractDimensionRows(widget, response)}
      currency={currency}
    />
  ),
}

interface WidgetRenderProps {
  widget: DashboardWidget
  response: Parameters<typeof extractMetricCardValue>[1]
  dateRange: { start: string; end: string }
  granularity: Granularity
  timezone: string
  currency: string
}

interface CustomWidgetProps {
  widget: DashboardWidget
  ctx: CompileContext
  /** Granularité courante du dashboard (pour le rendu time_series). */
  granularity: Granularity
  /** Devise du workspace (formatage des métriques de valeur). */
  currency: string
}

/**
 * Rend UN widget custom : compile sa config en requête utilisateur, la résout
 * via `analytics.query`, puis route le résultat vers le composant du registre
 * selon `kind`. Dégradation propre garantie :
 *  - kind inconnu (front en retard sur un nouveau kind backend) → carte d'info,
 *    pas de crash de toute la grille
 *  - erreur réseau/serveur → carte d'erreur localisée au widget
 *  - chargement → squelette
 */
export function CustomWidget({ widget, ctx, granularity, currency }: CustomWidgetProps) {
  const renderer = WIDGET_RENDERERS[widget.kind]
  const query = compileWidgetQuery(widget, ctx)

  const { data: response, isFetching, isError } = useQuery({
    ...analyticsQueryOptions(query),
    placeholderData: keepPreviousData,
    // Un kind inconnu n'a pas besoin de fetch (rien à rendre).
    enabled: !!renderer,
  })

  if (!renderer) {
    return (
      <WidgetShell title={widget.title}>
        <div className="flex items-center justify-center gap-2 text-gray-400 text-sm" style={{ height: 180 }}>
          <InfoCircleOutlined />
          Type de widget non reconnu ({widget.kind})
        </div>
      </WidgetShell>
    )
  }

  if (isError) {
    return (
      <WidgetShell title={widget.title}>
        <Alert
          type="warning"
          showIcon
          message="Widget indisponible"
          description="Impossible de charger les données de ce widget."
        />
      </WidgetShell>
    )
  }

  if (isFetching && !response) {
    return <WidgetSkeleton title={widget.title} />
  }

  const dateRange = {
    start: response?.meta?.dateRange?.start ?? '',
    end: response?.meta?.dateRange?.end ?? '',
  }

  return (
    <>
      {renderer({ widget, response, dateRange, granularity, timezone: ctx.timezone, currency })}
    </>
  )
}
