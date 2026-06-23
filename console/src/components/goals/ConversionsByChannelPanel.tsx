import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Table, Empty, Skeleton, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { api } from '../../lib/api'
import { channelGroupLabel, CHANNEL_GROUP_ORDER } from '../../lib/channel-labels'
import type {
  DateRange,
  ConversionsByChannelResponse,
  ConversionsByChannelRow,
} from '../../types/analytics'

interface ConversionsByChannelPanelProps {
  workspaceId: string
  dateRange: DateRange
  timezone: string
}

/**
 * Taux de conversion par canal × app, NATIF de la page Objectifs.
 *
 * Pour chaque (groupe de canal, app), affiche le nombre de conversions
 * (signup/app_started) et le taux vs les sessions du même canal. Répond au
 * différenciateur "quel canal me rapporte le plus de clients, et sur quelle app".
 */
export function ConversionsByChannelPanel({
  workspaceId,
  dateRange,
  timezone,
}: ConversionsByChannelPanelProps) {
  const { data, isLoading } = useQuery<ConversionsByChannelResponse>({
    queryKey: ['conversionsByChannel', workspaceId, dateRange],
    queryFn: () =>
      api.analytics.conversionsByChannel({
        workspace_id: workspaceId,
        dateRange,
        timezone,
      }),
    staleTime: 60_000,
  })

  const rows = useMemo(() => {
    const r = data?.rows ?? []
    // Sort by canonical channel order, then by conversions desc.
    const order = (g: string) => {
      const i = CHANNEL_GROUP_ORDER.indexOf(g as (typeof CHANNEL_GROUP_ORDER)[number])
      return i === -1 ? CHANNEL_GROUP_ORDER.length : i
    }
    return [...r].sort(
      (a, b) =>
        order(a.channel_group) - order(b.channel_group) ||
        b.conversions - a.conversions,
    )
  }, [data])

  const columns: ColumnsType<ConversionsByChannelRow> = [
    {
      title: 'Canal',
      dataIndex: 'channel_group',
      key: 'channel_group',
      render: (v: string) => <Tag>{channelGroupLabel(v)}</Tag>,
    },
    {
      title: 'App',
      dataIndex: 'app',
      key: 'app',
    },
    {
      title: 'Conversions',
      dataIndex: 'conversions',
      key: 'conversions',
      align: 'right',
      render: (v: number) => v.toLocaleString('fr-FR'),
      sorter: (a, b) => a.conversions - b.conversions,
    },
    {
      title: 'Sessions du canal',
      dataIndex: 'sessions',
      key: 'sessions',
      align: 'right',
      render: (v: number) => v.toLocaleString('fr-FR'),
    },
    {
      title: 'Taux de conversion',
      dataIndex: 'conversion_rate',
      key: 'conversion_rate',
      align: 'right',
      render: (v: number) => (
        <span
          className={
            v >= 5 ? 'text-green-600' : v >= 1 ? 'text-amber-600' : 'text-[var(--muted-foreground)]'
          }
        >
          {v.toLocaleString('fr-FR')} %
        </span>
      ),
      sorter: (a, b) => a.conversion_rate - b.conversion_rate,
      defaultSortOrder: 'descend',
    },
  ]

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Conversions par canal &amp; app</h2>
        <p className="text-sm text-[var(--muted-foreground)] mt-0.5">
          Taux de conversion (inscriptions) par groupe de canal d'acquisition et
          par application.
        </p>
      </div>

      {isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : rows.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Aucune conversion attribuée à un canal sur la période"
          className="py-10"
        />
      ) : (
        <Table
          size="small"
          rowKey={(r) => `${r.channel_group}::${r.app}`}
          columns={columns}
          dataSource={rows}
          pagination={false}
        />
      )}
    </div>
  )
}
