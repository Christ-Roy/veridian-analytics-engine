import { useState } from 'react'
import { Alert, Button, Progress, Space, InputNumber, Popconfirm, Typography, App } from 'antd'
import { PlayCircleOutlined, StopOutlined, SyncOutlined } from '@ant-design/icons'
import { useBackfillStatus } from '../../hooks/useBackfillStatus'
import type { BackfillTaskProgress } from '../../types/filters'

const { Text } = Typography

interface BackfillStatusProps {
  workspaceId: string
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`
}

export function BackfillStatus({ workspaceId }: BackfillStatusProps) {
  const { message } = App.useApp()
  const [lookbackDays, setLookbackDays] = useState(30)
  const {
    syncStatus,
    summary,
    taskProgress,
    startBackfill,
    cancelBackfill,
    isStarting,
    isCancelling,
    isLoading,
  } = useBackfillStatus(workspaceId)

  if (isLoading || !summary) return null

  // Return null if synced (no UI needed)
  if (syncStatus === 'synced') return null

  // Show progress bar when task is active
  const activeTask: BackfillTaskProgress | null = taskProgress || null
  if (syncStatus === 'syncing' && activeTask) {
    return (
      <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
        <div className="flex items-center justify-between mb-2">
          <Space>
            <SyncOutlined spin className="text-blue-500" />
            <Text strong>
              {activeTask.status === 'pending' ? 'Préparation du retraitement…' : 'Retraitement en cours'}
            </Text>
          </Space>
          <Popconfirm
            title="Annuler le retraitement ?"
            description="La progression sera perdue."
            onConfirm={() => {
              cancelBackfill().then(() => message.info('Retraitement annulé'))
            }}
            okText="Oui, annuler"
            cancelText="Non"
          >
            <Button size="small" icon={<StopOutlined />} loading={isCancelling}>
              Annuler
            </Button>
          </Popconfirm>
        </div>

        <Progress
          percent={activeTask.progress_percent}
          status="active"
          strokeColor={{ from: '#1890ff', to: '#52c41a' }}
        />

        <div className="mt-2 text-sm text-gray-500">
          <Space split="·">
            <span>
              {activeTask.sessions.processed.toLocaleString()} /{' '}
              {activeTask.sessions.total.toLocaleString()} sessions
            </span>
            {activeTask.current_chunk && <span>En cours : {activeTask.current_chunk}</span>}
            {activeTask.estimated_remaining_seconds && activeTask.estimated_remaining_seconds > 0 && (
              <span>~{formatDuration(activeTask.estimated_remaining_seconds)} restantes</span>
            )}
          </Space>
        </div>
      </div>
    )
  }

  // Show alert when backfill is needed
  if (summary.needsBackfill) {
    return (
      <Alert
        type="info"
        showIcon
        className="!mb-4"
        message="La configuration des filtres a changé"
        description={
          <div className="flex items-center justify-between mt-2">
            <Text type="secondary">
              {summary.lastCompletedFilterVersion
                ? 'Les données historiques ont été traitées avec une configuration de filtres différente.'
                : "Aucun retraitement n'a encore été lancé. Lancez un retraitement pour appliquer les filtres aux données historiques."}
            </Text>
            <Space>
              <Text type="secondary">Période :</Text>
              <InputNumber
                min={1}
                max={365}
                value={lookbackDays}
                onChange={(v) => setLookbackDays(v || 30)}
                addonAfter="jours"
                style={{ width: 130 }}
              />
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => {
                  startBackfill(lookbackDays).then(() => message.success('Retraitement démarré'))
                }}
                loading={isStarting}
              >
                Lancer le retraitement
              </Button>
            </Space>
          </div>
        }
      />
    )
  }

  // No alert needed when everything is up to date
  return null
}
