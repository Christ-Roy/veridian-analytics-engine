import { useState, useMemo, useCallback } from 'react'
import { useQuery, keepPreviousData } from '@tanstack/react-query'
import { Alert } from 'antd'
import { getDeviceIcon } from '../../lib/device-icons'
import { analyticsQueryOptions } from '../../lib/queries'
import { determineGranularity, getAvailableGranularities } from '../../lib/chart-utils'
import { determineGranularityForRange, computeDateRange } from '../../lib/date-utils'
import { useDashboardParams } from '../../hooks/useDashboardParams'
import { DashboardProvider } from '../../hooks/useDashboardContext'
import { MetricSummary } from './MetricSummary'
import { MetricChart } from './MetricChart'
import { GranularitySelector } from './GranularitySelector'
import { DimensionTableWidget } from './DimensionTableWidget'
import { TrafficHeatmapWidget, type HeatmapDataPoint } from './TrafficHeatmapWidget'
import {
  METRICS,
  extractDashboardData,
  extractKpiTotals,
  type MetricKey,
  type ComparisonMode,
  type DimensionTabConfig,
  type ColumnConfig,
} from '../../types/dashboard'
import type { DatePreset, Granularity, Filter } from '../../types/analytics'
import type { Annotation } from '../../types/workspace'

interface DashboardGridProps {
  workspaceId: string
  workspaceTimezone: string
  workspaceCurrency: string
  timescoreReference: number
  comparison: ComparisonMode
  customStart?: string
  customEnd?: string
  annotations?: Annotation[]
  globalFilters?: Filter[]
  onAddFilter?: (filter: Filter | Filter[]) => void
}

export function DashboardGrid({
  workspaceId,
  workspaceTimezone,
  workspaceCurrency,
  timescoreReference,
  comparison,
  customStart,
  customEnd,
  annotations,
  globalFilters = [],
  onAddFilter
}: DashboardGridProps) {
  const [selectedMetric, setSelectedMetric] = useState<MetricKey>('sessions')
  const [showEvoDetails, setShowEvoDetails] = useState(false)
  const { period, timezone } = useDashboardParams(workspaceTimezone)

  // Key for resetting granularity override when period changes
  const periodKey = `${period}-${customStart}-${customEnd}`
  const [granularityOverride, setGranularityOverride] = useState<{ key: string; value: Granularity | null }>({ key: periodKey, value: null })

  // Reset override if period changed
  const currentOverride = granularityOverride.key === periodKey ? granularityOverride.value : null

  // Compute date range to get the number of days
  const dateRangeForGranularity = useMemo(() => {
    if (period === 'custom' && customStart && customEnd) {
      return computeDateRange('custom', timezone, { start: customStart, end: customEnd })
    }
    return computeDateRange(period as DatePreset, timezone)
  }, [period, timezone, customStart, customEnd])

  const dateRangeDays = dateRangeForGranularity.end.diff(dateRangeForGranularity.start, 'day')
  const availableGranularities = getAvailableGranularities(dateRangeDays)

  // Determine default granularity
  const defaultGranularity = period === 'custom' && customStart && customEnd
    ? determineGranularityForRange(dateRangeForGranularity.start, dateRangeForGranularity.end)
    : determineGranularity(period as DatePreset)

  // Use override if valid, otherwise default
  const granularity = currentOverride && availableGranularities.includes(currentOverride)
    ? currentOverride
    : defaultGranularity

  // Handler to update granularity override
  const handleGranularityChange = useCallback((value: Granularity | null) => {
    setGranularityOverride({ key: periodKey, value })
  }, [periodKey])

  const showComparison = comparison !== 'none'

  // Build date range objects for context (no granularity - only for time-series)
  const dateRange = useMemo(() => {
    if (period === 'custom' && customStart && customEnd) {
      return { start: customStart, end: customEnd }
    }
    return { preset: period as DatePreset }
  }, [period, customStart, customEnd])

  const compareDateRange = useMemo(() => {
    if (!showComparison) return undefined
    if (period === 'custom' && customStart && customEnd) {
      return { start: customStart, end: customEnd }
    }
    return { preset: period as DatePreset }
  }, [showComparison, period, customStart, customEnd])

  // Main metrics query (for time-series chart)
  const metricsQuery = {
    workspace_id: workspaceId,
    metrics: METRICS.map((m) => m.key),
    filters: globalFilters.length > 0 ? globalFilters : undefined,
    dateRange: {
      preset: period as DatePreset,
      granularity,
      ...(period === 'custom' &&
        customStart &&
        customEnd && {
          start: customStart,
          end: customEnd,
          preset: undefined
        })
    },
    ...(showComparison && {
      compareDateRange: {
        preset: period as DatePreset,
        granularity,
        ...(period === 'custom' &&
          customStart &&
          customEnd && {
            start: customStart,
            end: customEnd,
            preset: undefined
          })
      }
    }),
    timezone
  }

  const {
    data: response,
    isFetching,
    isError,
    error
  } = useQuery({
    ...analyticsQueryOptions(metricsQuery),
    placeholderData: keepPreviousData
  })

  const dashboardData = response ? extractDashboardData(response, granularity) : null

  // KPI totals query (no granularity for accurate aggregated values)
  const kpiTotalsQuery = {
    workspace_id: workspaceId,
    metrics: METRICS.map((m) => m.key),
    filters: globalFilters.length > 0 ? globalFilters : undefined,
    dateRange: {
      preset: period as DatePreset,
      // NO granularity here - we want the true aggregated values
      ...(period === 'custom' &&
        customStart &&
        customEnd && {
          start: customStart,
          end: customEnd,
          preset: undefined
        })
    },
    ...(showComparison && {
      compareDateRange: {
        preset: period as DatePreset,
        ...(period === 'custom' &&
          customStart &&
          customEnd && {
            start: customStart,
            end: customEnd,
            preset: undefined
          })
      }
    }),
    timezone
  }

  const { data: kpiTotalsResponse, isFetching: kpiFetching } = useQuery({
    ...analyticsQueryOptions(kpiTotalsQuery),
    placeholderData: keepPreviousData
  })

  const kpiTotals = kpiTotalsResponse ? extractKpiTotals(kpiTotalsResponse) : null

  // Heatmap query - day_of_week x hour aggregation (no comparison)
  const heatmapQuery = {
    workspace_id: workspaceId,
    metrics: ['sessions', 'median_duration'],
    dimensions: ['day_of_week', 'hour'],
    filters: globalFilters.length > 0 ? globalFilters : undefined,
    dateRange: {
      preset: period as DatePreset,
      ...(period === 'custom' &&
        customStart &&
        customEnd && {
          start: customStart,
          end: customEnd,
          preset: undefined
        })
    },
    timezone
  }

  const { data: heatmapResponse, isFetching: heatmapFetching } = useQuery({
    ...analyticsQueryOptions(heatmapQuery),
    placeholderData: keepPreviousData
  })

  // Transform heatmap response
  const heatmapData: HeatmapDataPoint[] = useMemo(() => {
    if (!heatmapResponse?.data) return []

    const rows = Array.isArray(heatmapResponse.data) ? heatmapResponse.data : []

    return rows.map((row: Record<string, unknown>) => ({
      day_of_week: row.day_of_week as number,
      hour: row.hour as number,
      sessions: row.sessions as number,
      median_duration: row.median_duration as number
    }))
  }, [heatmapResponse])

  // Widget tab configurations
  const pagesTabConfig: DimensionTabConfig[] = [
    {
      key: 'landing',
      label: 'Pages d\'entrée',
      dimensionLabel: 'Page',
      dimension: 'landing_path',
      metrics: ['sessions', 'median_duration', 'bounce_rate']
    },
    {
      key: 'exits',
      label: 'Sorties',
      dimensionLabel: 'Page de sortie',
      dimension: 'exit_path',
      metrics: ['sessions', 'median_duration']
    }
  ]

  const sourcesTabConfig: DimensionTabConfig[] = [
    {
      key: 'referrers',
      label: 'Référents',
      dimensionLabel: 'Domaine référent',
      dimension: 'referrer_domain'
    },
    {
      key: 'channels',
      label: 'Canaux',
      dimensionLabel: 'Canal',
      dimension: 'channel'
    },
    {
      key: 'channel_groups',
      label: 'Groupes de canaux',
      dimensionLabel: 'Groupe de canaux',
      dimension: 'channel_group'
    }
  ]

  const campaignsTabConfig: DimensionTabConfig[] = [
    {
      key: 'campaign',
      label: 'Campagnes',
      dimensionLabel: 'utm_campaign',
      dimension: 'utm_campaign',
      filters: [{ dimension: 'utm_campaign', operator: 'isNotEmpty' }]
    },
    {
      key: 'source',
      label: 'Sources',
      dimensionLabel: 'utm_source',
      dimension: 'utm_source',
      filters: [{ dimension: 'utm_source', operator: 'isNotEmpty' }]
    },
    {
      key: 'medium',
      label: 'Supports',
      dimensionLabel: 'utm_medium',
      dimension: 'utm_medium',
      filters: [{ dimension: 'utm_medium', operator: 'isNotEmpty' }]
    },
    {
      key: 'content',
      label: 'Contenus',
      dimensionLabel: 'utm_content',
      dimension: 'utm_content',
      filters: [{ dimension: 'utm_content', operator: 'isNotEmpty' }]
    },
    {
      key: 'term',
      label: 'Mots-clés',
      dimensionLabel: 'utm_term',
      dimension: 'utm_term',
      filters: [{ dimension: 'utm_term', operator: 'isNotEmpty' }]
    }
  ]

  const countriesTabConfig: DimensionTabConfig[] = [
    {
      key: 'map',
      label: 'Carte',
      dimensionLabel: 'Pays',
      dimension: 'country',
      type: 'country_map',
      limit: 100
    },
    {
      key: 'list',
      label: 'Liste',
      dimensionLabel: 'Pays',
      dimension: 'country'
    }
  ]

  const devicesTabConfig: DimensionTabConfig[] = [
    { key: 'devices', label: 'Appareils', dimensionLabel: 'Appareil', dimension: 'device' },
    { key: 'browsers', label: 'Navigateurs', dimensionLabel: 'Navigateur', dimension: 'browser' },
    { key: 'os', label: 'OS', dimensionLabel: 'OS', dimension: 'os' }
  ]

  const goalsTabConfig: DimensionTabConfig[] = [
    {
      key: 'goals',
      label: 'Objectifs',
      dimensionLabel: 'Objectif',
      dimension: 'goal_name',
      table: 'goals',
      metrics: ['goals', 'sum_goal_value'],
      order: { goals: 'desc' }
    }
  ]

  const goalsColumns: ColumnConfig[] = [
    { key: 'goals', label: 'Nombre', format: 'number' },
    { key: 'sum_goal_value', label: 'Valeur', format: 'currency', currency: workspaceCurrency }
  ]

  // « Pages les plus vues » — table `pages` (analytics par page, peuplée en
  // continu par pages_mv). Distinct des onglets « Pages d'entrée » / « Sorties »
  // ci-dessus qui viennent de la table `sessions`.
  const pageViewsTabConfig: DimensionTabConfig[] = [
    {
      key: 'page_views',
      label: 'Pages les plus vues',
      dimensionLabel: 'Page',
      dimension: 'page_path',
      // La dimension `page_path` est la seule dont la colonne ClickHouse
      // (`path`) diffère du nom : le query-builder SELECT la colonne brute
      // sans alias, donc la réponse renvoie `path`, pas `page_path`.
      dimensionField: 'path',
      table: 'pages',
      metrics: ['page_count', 'page_duration', 'page_scroll', 'exit_rate'],
      order: { page_count: 'desc' }
    }
  ]

  const pageViewsColumns: ColumnConfig[] = [
    { key: 'page_count', label: 'Vues', format: 'number' },
    { key: 'page_duration', label: 'Temps médian', format: 'duration' },
    { key: 'page_scroll', label: 'Scroll médian', format: 'percentage' },
    { key: 'exit_rate', label: 'Taux de sortie', format: 'percentage' }
  ]

  // Mapping from tab key to dimension for click-to-filter
  const tabKeyToDimension: Record<string, string> = useMemo(() => ({
    // Pages
    landing: 'landing_path',
    exit: 'exit_path',
    // Sources
    referrers: 'referrer_domain',
    channels: 'channel',
    channel_groups: 'channel_group',
    // Campaigns
    campaign: 'utm_campaign',
    source: 'utm_source',
    medium: 'utm_medium',
    content: 'utm_content',
    term: 'utm_term',
    // Countries
    map: 'country',
    list: 'country',
    // Devices
    devices: 'device',
    browsers: 'browser',
    os: 'os',
    // Goals
    goals: 'goal_name',
  }), [])

  // Generic row click handler that adds a filter
  const handleRowClick = useCallback((row: { dimension_value: string }, tabKey: string) => {
    if (!onAddFilter) return
    const dimension = tabKeyToDimension[tabKey]
    if (!dimension) return

    onAddFilter({
      dimension,
      operator: 'equals',
      values: [row.dimension_value]
    })
  }, [onAddFilter, tabKeyToDimension])

  // Heatmap cell click handler - adds filters for day_of_week and hour atomically
  const handleHeatmapCellClick = useCallback((dayOfWeek: number, hour: number) => {
    if (!onAddFilter) return
    // Add both filters in a single call for atomic URL update
    onAddFilter([
      { dimension: 'day_of_week', operator: 'equals', values: [dayOfWeek] },
      { dimension: 'hour', operator: 'equals', values: [hour] }
    ])
  }, [onAddFilter])

  if (isError) {
    return (
      <Alert
        message="Erreur lors du chargement des données du tableau de bord"
        description={error instanceof Error ? error.message : "Une erreur inattendue s'est produite"}
        type="error"
        showIcon
      />
    )
  }

  const metric = METRICS.find((m) => m.key === selectedMetric)!
  const metricData = dashboardData?.metrics[selectedMetric]

  return (
    <DashboardProvider
      workspaceId={workspaceId}
      dateRange={dateRange}
      compareDateRange={compareDateRange}
      timezone={timezone}
      globalFilters={globalFilters}
      showComparison={showComparison}
      timescoreReference={timescoreReference}
      showEvoDetails={showEvoDetails}
      setShowEvoDetails={setShowEvoDetails}
    >
      <div className={isFetching ? 'opacity-75 transition-opacity' : ''}>
        <div className="rounded-md overflow-hidden bg-white">
          <MetricSummary
            kpiTotals={kpiTotals}
            loading={(!response && isFetching) || (!kpiTotalsResponse && kpiFetching)}
            selectedMetric={selectedMetric}
            onMetricSelect={setSelectedMetric}
            showComparison={showComparison}
          />
          <div className="pl-2 pr-4 pt-4 pb-3 relative">
            {availableGranularities.length > 1 && (
              <div className="absolute top-4 right-4 z-10">
                <GranularitySelector
                  value={granularity}
                  onChange={handleGranularityChange}
                  availableGranularities={availableGranularities}
                />
              </div>
            )}
            <MetricChart
              metric={metric}
              currentData={metricData?.current ?? []}
              previousData={showComparison ? (metricData?.previous ?? []) : []}
              granularity={granularity}
              dateRange={dashboardData?.dateRange ?? { start: '', end: '' }}
              compareDateRange={dashboardData?.compareDateRange ?? { start: '', end: '' }}
              loading={!response && isFetching}
              height={200}
              annotations={annotations}
              timezone={workspaceTimezone}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <DimensionTableWidget
            title="Pages les plus consultées"
            tabs={pagesTabConfig}
            onRowClick={handleRowClick}
          />
          <DimensionTableWidget
            title="Sources principales"
            tabs={sourcesTabConfig}
            iconPrefix={(value, tabKey) =>
              tabKey === 'referrers' && value ? (
                <img
                  src={`/api/tools.favicon?url=https://${encodeURIComponent(value)}`}
                  alt=""
                  className="w-4 h-4 shrink-0"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
              ) : null
            }
            onRowClick={handleRowClick}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          {/* Pas de onRowClick : un filtre `page_path` (dimension propre à la
              table `pages`) propagé aux filtres globaux casserait tous les
              widgets sur les tables `sessions`/`goals` (le backend rejette une
              dimension absente de la table interrogée). Widget informatif. */}
          <DimensionTableWidget
            title="Pages les plus vues"
            infoTooltip="Pages les plus consultées, avec le temps médian passé, la profondeur de scroll médiane et le taux de sortie"
            tabs={pageViewsTabConfig}
            columns={pageViewsColumns}
            emptyText="Aucune donnée de page"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <DimensionTableWidget
            title="Campagnes principales"
            tabs={campaignsTabConfig}
            emptyText="Aucune donnée de campagne"
            onRowClick={handleRowClick}
          />
          <DimensionTableWidget
            title="Pays"
            tabs={countriesTabConfig}
            iconPrefix={(value, tabKey) =>
              tabKey === 'list' && value ? <span className={`fi fi-${value.toLowerCase()} shrink-0 relative`} /> : null
            }
            emptyText="Aucune donnée de pays"
            onRowClick={handleRowClick}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <TrafficHeatmapWidget
            title="Trafic par jour et heure"
            data={heatmapData}
            loading={heatmapFetching && !heatmapResponse}
            timescoreReference={timescoreReference}
            emptyText="Aucune donnée de trafic"
            onCellClick={handleHeatmapCellClick}
          />
          <DimensionTableWidget
            title="Appareils"
            tabs={devicesTabConfig}
            iconPrefix={getDeviceIcon}
            onRowClick={handleRowClick}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <DimensionTableWidget
            title="Objectifs"
            infoTooltip="Suivez les conversions de vos objectifs et leur valeur totale"
            tabs={goalsTabConfig}
            columns={goalsColumns}
            emptyText="Aucune donnée d'objectif"
            onRowClick={handleRowClick}
          />
        </div>
      </div>
    </DashboardProvider>
  )
}
