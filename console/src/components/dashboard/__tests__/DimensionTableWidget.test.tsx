import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DimensionData, DimensionTabConfig, ColumnConfig } from '../../../types/dashboard'

// ECharts (utilisé par CountryMapView en cas de tab country_map) touche le
// canvas DOM — on stub pour garder le test rapide et isolé du moteur graphique.
vi.mock('echarts-for-react', () => ({ default: () => null }))

// On mocke les deux hooks d'I/O : le widget récupère ses données via
// useDimensionQuery et son contexte via useDashboardContext (qui throw hors
// Provider). On contrôle ainsi exactement la forme des lignes rendues.
const mockUseDimensionQuery = vi.fn()
vi.mock('../../../hooks/useDimensionQuery', () => ({
  useDimensionQuery: (...args: unknown[]) => mockUseDimensionQuery(...args),
}))
vi.mock('../../../hooks/useDashboardContext', () => ({
  useDashboardContext: () => ({
    workspaceId: 'ws_test',
    dateRange: { preset: 'previous_28_days' },
    timezone: 'Europe/Paris',
    globalFilters: [],
    showComparison: true, // chemin getChange + Math.abs(change).toFixed()
    timescoreReference: 60,
    showEvoDetails: false,
    setShowEvoDetails: vi.fn(),
  }),
}))

import { DimensionTableWidget } from '../DimensionTableWidget'

const TAB: DimensionTabConfig = {
  key: 'devices',
  label: 'Appareils',
  dimensionLabel: 'Appareil',
  dimension: 'device',
}

// Colonnes telles que configurées en prod après le renommage métrique
// (commit fd91e83 "visiteurs uniques B2B") : unique_visitors + sessions.
const COLUMNS: ColumnConfig[] = [
  { key: 'unique_visitors', label: 'Visiteurs', format: 'number' },
  { key: 'sessions', label: 'Visites', format: 'number' },
  { key: 'median_duration', label: 'TimeScore', format: 'duration', heatMap: true },
]

function renderWidget(data: DimensionData[]) {
  mockUseDimensionQuery.mockReturnValue({ data, loading: false })
  return render(
    <DimensionTableWidget title="Appareils" tabs={[TAB]} columns={COLUMNS} />
  )
}

describe('DimensionTableWidget — robustesse colonne absente (régression prod 2026-06-29)', () => {
  beforeEach(() => {
    mockUseDimensionQuery.mockReset()
  })

  // LE cas qui a planté la prod : une colonne configurée (`unique_visitors`)
  // est ABSENTE de la ligne de données → `row[col.key]` = undefined →
  // formatValue(undefined).toFixed() → crash de TOUT le dashboard.
  it('ne crashe pas quand une colonne configurée est absente de la ligne', () => {
    const data: DimensionData[] = [
      // `unique_visitors` volontairement absent : la ligne ne porte que sessions.
      { dimension_value: 'Desktop', sessions: 1200, median_duration: 45 },
      { dimension_value: 'Mobile', sessions: 800, median_duration: 30 },
    ]
    expect(() => renderWidget(data)).not.toThrow()
    // La dimension reste rendue malgré la métrique manquante.
    expect(screen.getByText('Desktop')).toBeInTheDocument()
    expect(screen.getByText('Mobile')).toBeInTheDocument()
  })

  it('ne crashe pas quand une métrique vaut explicitement undefined ou null', () => {
    const data: DimensionData[] = [
      { dimension_value: 'Desktop', unique_visitors: undefined, sessions: 1200, median_duration: 45 },
      { dimension_value: 'Mobile', unique_visitors: null as unknown as undefined, sessions: 800, median_duration: 30 },
    ]
    expect(() => renderWidget(data)).not.toThrow()
    expect(screen.getByText('Desktop')).toBeInTheDocument()
  })

  it('ne crashe pas avec des métriques en string (ClickHouse)', () => {
    const data: DimensionData[] = [
      { dimension_value: 'Desktop', unique_visitors: '950', sessions: '1200', median_duration: '45' },
    ]
    expect(() => renderWidget(data)).not.toThrow()
    expect(screen.getByText('Desktop')).toBeInTheDocument()
  })

  it('rend correctement des données complètes et valides', () => {
    const data: DimensionData[] = [
      { dimension_value: 'Desktop', unique_visitors: 950, sessions: 1200, median_duration: 45 },
    ]
    expect(() => renderWidget(data)).not.toThrow()
    expect(screen.getByText('Desktop')).toBeInTheDocument()
  })
})
