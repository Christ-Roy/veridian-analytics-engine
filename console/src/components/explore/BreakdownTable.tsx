import { Table, Tooltip } from 'antd'
import type { UseQueryResult } from '@tanstack/react-query'
import { HeatMapCell } from './HeatMapCell'
import { getDimensionLabel, EMPTY_VALUE_LABEL } from '../../lib/explore-utils'
import { DaysOfWeek } from '../../lib/dictionaries'
import { formatNumber } from '../../lib/chart-utils'
import type { AnalyticsResponse } from '../../types/analytics'
import type { CustomDimensionLabels } from '../../types/workspace'

interface BreakdownTableViewProps {
  dimension: string
  query: UseQueryResult<AnalyticsResponse, Error>
  timescoreReference: number
  customDimensionLabels?: CustomDimensionLabels | null
}

export function BreakdownTableView({
  dimension,
  query,
  timescoreReference,
  customDimensionLabels,
}: BreakdownTableViewProps) {
  const { data, isLoading, error } = query

  // Handle comparison data structure
  const rows = Array.isArray(data?.data)
    ? data.data
    : (data?.data as { current?: unknown[] })?.current || []

  // Find max median_duration for heat map scaling (start from 0, let color function handle reference)
  const maxMedian = (rows as Record<string, unknown>[]).reduce(
    (max, row) => Math.max(max, (row.median_duration as number) || 0),
    0
  )

  const columns = [
    {
      title: getDimensionLabel(dimension, customDimensionLabels),
      dataIndex: dimension,
      ellipsis: true,
      render: (value: unknown) => {
        if (value === null || value === '') return <span className="text-gray-400">{EMPTY_VALUE_LABEL}</span>
        if (dimension === 'day_of_week' && typeof value === 'number') {
          return DaysOfWeek[value] ?? String(value)
        }
        return String(value)
      },
    },
    {
      title: 'Visiteurs',
      dataIndex: 'unique_visitors',
      width: 90,
      align: 'right' as const,
      render: (v: number) => formatNumber(v),
    },
    {
      title: 'Visites',
      dataIndex: 'sessions',
      width: 80,
      align: 'right' as const,
      render: (v: number) => formatNumber(v),
    },
    {
      title: (
        <Tooltip title="Vert = atteint la référence, Cyan = dépasse la référence">
          <span className="cursor-help border-b border-dotted border-gray-400">TimeScore</span>
        </Tooltip>
      ),
      dataIndex: 'median_duration',
      width: 100,
      align: 'right' as const,
      render: (v: number) => <HeatMapCell value={v} bestValue={maxMedian} referenceValue={timescoreReference} />,
    },
    {
      title: 'Rebond',
      dataIndex: 'bounce_rate',
      width: 70,
      align: 'right' as const,
      render: (v: number) => `${(v * 100).toFixed(1)}%`,
    },
  ]

  if (error) {
    return (
      <div className="p-4 bg-red-50 rounded text-red-600 text-sm">
        Erreur lors du chargement de la décomposition
      </div>
    )
  }

  return (
    <Table
      columns={columns}
      dataSource={rows as Record<string, unknown>[]}
      loading={isLoading}
      pagination={{ pageSize: 10, size: 'small', showSizeChanger: false, hideOnSinglePage: true }}
      size="small"
      rowKey={(row) => String(row[dimension] ?? 'null')}
    />
  )
}
