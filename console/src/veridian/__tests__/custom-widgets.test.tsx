import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// ECharts touche le DOM canvas — non requis ici (on ne rend pas le time_series,
// seulement metric_card / dimension_table). On stub le composant pour garder le
// test rapide et isolé du moteur de rendu graphique.
vi.mock('echarts-for-react', () => ({
  default: () => null,
}))
import {
  compileWidgetQuery,
  extractMetricCardValue,
  extractTimeSeriesPoints,
  extractDimensionRows,
  widgetFormat,
  type CompileContext,
} from '../../components/dashboard/custom-widget'
import { WIDGET_RENDERERS } from '../../components/dashboard/CustomWidget'
import {
  isWidgetSafeMetric,
  isWidgetSafeDimension,
  widgetMetricFormat,
} from '../../components/dashboard/widget-catalog'
import type { AnalyticsResponse } from '../../types/analytics'
import type { DashboardWidget } from '../../types/workspace'

const CTX: CompileContext = {
  workspaceId: 'ws_test',
  dateRange: { preset: 'previous_28_days' },
  timezone: 'Europe/Paris',
  globalFilters: [{ dimension: 'device', operator: 'equals', values: ['mobile'] }],
}

function resp(data: Record<string, unknown>[]): AnalyticsResponse {
  return {
    data,
    meta: {
      metrics: [],
      dimensions: [],
      dateRange: { start: '2026-06-01', end: '2026-06-28' },
      total_rows: data.length,
    },
    // L'engine n'expose JAMAIS la requête (anti-fuite SQL) ; le type console le
    // déclare encore — on le satisfait avec un stub neutre pour les tests.
    query: { sql: '', params: {} },
  }
}

/* ── Catalogue widget-safe (source unique partagée avec le backend) ──────── */
describe('widget-catalog (source unique)', () => {
  it('expose les métriques/dimensions widget-safe et exclut les identifiants sensibles', () => {
    expect(isWidgetSafeMetric('sessions')).toBe(true)
    expect(isWidgetSafeDimension('channel')).toBe(true)
    // user_id / visitor_id / fingerprint volontairement absents du catalogue.
    expect(isWidgetSafeMetric('user_id')).toBe(false)
    expect(isWidgetSafeDimension('visitor_id')).toBe(false)
    expect(isWidgetSafeDimension('fingerprint')).toBe(false)
  })

  it('dérive le format d’affichage de la clé de métrique', () => {
    expect(widgetMetricFormat('bounce_rate')).toBe('percentage')
    expect(widgetMetricFormat('median_duration')).toBe('duration')
    expect(widgetMetricFormat('sum_goal_value')).toBe('currency')
    expect(widgetMetricFormat('sessions')).toBe('number')
  })
})

/* ── Compilation config → AnalyticsQuery (miroir du backend widgetData) ──── */
describe('compileWidgetQuery', () => {
  it('metric_card : pas de dimension, pas de granularité, pas de limit', () => {
    const w: DashboardWidget = { id: 'w1', kind: 'metric_card', title: 'KPI', metric: 'sessions' }
    const q = compileWidgetQuery(w, CTX)
    expect(q.dimensions).toEqual([])
    expect(q.dateRange.granularity).toBeUndefined()
    expect(q.limit).toBeUndefined()
    expect(q.table).toBe('sessions')
  })

  it('time_series : granularité du config fait autorité', () => {
    const w: DashboardWidget = { id: 'w2', kind: 'time_series', title: 'Tendance', metric: 'sessions', granularity: 'week' }
    const q = compileWidgetQuery(w, CTX)
    expect(q.dateRange.granularity).toBe('week')
    expect(q.dimensions).toEqual([])
    expect(q.limit).toBeUndefined()
  })

  it('dimension_table : groupe par dimension, ordre desc sur la métrique, limit par défaut 10', () => {
    const w: DashboardWidget = { id: 'w3', kind: 'dimension_table', title: 'Canaux', metric: 'sessions', dimension: 'channel' }
    const q = compileWidgetQuery(w, CTX)
    expect(q.dimensions).toEqual(['channel'])
    expect(q.order).toEqual({ sessions: 'desc' })
    expect(q.limit).toBe(10)
  })

  it('respecte un limit custom et la table', () => {
    const w: DashboardWidget = { id: 'w4', kind: 'dimension_table', title: 'Pages', metric: 'page_count', dimension: 'page_path', table: 'pages', limit: 5 }
    const q = compileWidgetQuery(w, CTX)
    expect(q.limit).toBe(5)
    expect(q.table).toBe('pages')
  })

  it('fusionne les filtres globaux + filtres du widget (le widget prime sur la même dimension)', () => {
    const w: DashboardWidget = {
      id: 'w5', kind: 'metric_card', title: 'KPI', metric: 'sessions',
      filters: [{ dimension: 'device', operator: 'equals', values: ['desktop'] }],
    }
    const q = compileWidgetQuery(w, CTX)
    // Un seul filtre `device` : celui du widget (le global de même dim est évincé).
    const deviceFilters = q.filters!.filter((f) => f.dimension === 'device')
    expect(deviceFilters).toHaveLength(1)
    expect(deviceFilters[0].values).toEqual(['desktop'])
  })

  it('conserve les filtres globaux d’une autre dimension', () => {
    const w: DashboardWidget = { id: 'w6', kind: 'metric_card', title: 'KPI', metric: 'sessions' }
    const q = compileWidgetQuery(w, CTX)
    expect(q.filters).toEqual([{ dimension: 'device', operator: 'equals', values: ['mobile'] }])
  })
})

/* ── Extraction des données (coercition string→number ClickHouse) ───────── */
describe('extracteurs de données', () => {
  it('metric_card lit la 1ʳᵉ ligne et coerce la valeur string', () => {
    const w: DashboardWidget = { id: 'm', kind: 'metric_card', title: '', metric: 'sessions' }
    // ClickHouse sérialise les agrégats en string.
    expect(extractMetricCardValue(w, resp([{ sessions: '4200' }]))).toBe(4200)
    expect(extractMetricCardValue(w, resp([]))).toBe(0)
    expect(extractMetricCardValue(w, undefined)).toBe(0)
  })

  it('time_series mappe {timestamp, value} sur la colonne de date de la granularité', () => {
    const w: DashboardWidget = { id: 't', kind: 'time_series', title: '', metric: 'sessions', granularity: 'day' }
    const pts = extractTimeSeriesPoints(w, resp([
      { date_day: '2026-06-01', sessions: '10' },
      { date_day: '2026-06-02', sessions: '20' },
    ]))
    expect(pts).toEqual([
      { timestamp: '2026-06-01', value: 10 },
      { timestamp: '2026-06-02', value: 20 },
    ])
  })

  it('dimension_table mappe {dimension_value, value} et gère la valeur vide', () => {
    const w: DashboardWidget = { id: 'd', kind: 'dimension_table', title: '', metric: 'sessions', dimension: 'channel' }
    const rows = extractDimensionRows(w, resp([
      { channel: 'organic', sessions: '100' },
      { channel: null, sessions: '5' },
    ]))
    expect(rows).toEqual([
      { dimension_value: 'organic', value: 100 },
      { dimension_value: '', value: 5 },
    ])
  })

  it('widgetFormat reflète le format dérivé de la métrique', () => {
    expect(widgetFormat({ id: 'x', kind: 'metric_card', title: '', metric: 'bounce_rate' })).toBe('percentage')
  })
})

/* ── Registre kind → composant ──────────────────────────────────────────── */
describe('WIDGET_RENDERERS (registre)', () => {
  const baseProps = {
    dateRange: { start: '2026-06-01', end: '2026-06-28' },
    granularity: 'day' as const,
    timezone: 'Europe/Paris',
    currency: 'EUR',
  }

  it('route les 3 kinds vers un composant', () => {
    expect(typeof WIDGET_RENDERERS.metric_card).toBe('function')
    expect(typeof WIDGET_RENDERERS.time_series).toBe('function')
    expect(typeof WIDGET_RENDERERS.dimension_table).toBe('function')
  })

  it('metric_card rend la valeur agrégée formatée', () => {
    const w: DashboardWidget = { id: 'mc', kind: 'metric_card', title: 'Visites', metric: 'sessions' }
    render(<>{WIDGET_RENDERERS.metric_card({ ...baseProps, widget: w, response: resp([{ sessions: '1234' }]) })}</>)
    expect(screen.getByTestId('custom-metric-card')).toBeInTheDocument()
    expect(screen.getByText('Visites')).toBeInTheDocument()
    // 1234 formaté en "1.2K" par formatNumber natif.
    expect(screen.getByText('1.2K')).toBeInTheDocument()
  })

  it('dimension_table rend une ligne par dimension', () => {
    const w: DashboardWidget = { id: 'dt', kind: 'dimension_table', title: 'Canaux', metric: 'sessions', dimension: 'channel' }
    render(<>{WIDGET_RENDERERS.dimension_table({
      ...baseProps,
      widget: w,
      response: resp([{ channel: 'organic', sessions: '100' }, { channel: 'direct', sessions: '50' }]),
    })}</>)
    expect(screen.getByTestId('custom-dimension-table')).toBeInTheDocument()
    expect(screen.getByText('organic')).toBeInTheDocument()
    expect(screen.getByText('direct')).toBeInTheDocument()
  })

  it('dimension_table vide → état vide propre (pas de crash)', () => {
    const w: DashboardWidget = { id: 'dt0', kind: 'dimension_table', title: 'Canaux', metric: 'sessions', dimension: 'channel' }
    render(<>{WIDGET_RENDERERS.dimension_table({ ...baseProps, widget: w, response: resp([]) })}</>)
    expect(screen.getByText('Aucune donnée disponible')).toBeInTheDocument()
  })

  it('un kind absent du registre n’existe pas (le composant CustomWidget dégrade alors proprement)', () => {
    // Garantit qu’un kind inconnu ne renvoie pas un renderer fantôme.
    expect((WIDGET_RENDERERS as Record<string, unknown>)['unknown_kind']).toBeUndefined()
  })
})
