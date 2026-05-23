import { useState, useEffect, useCallback } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Spin, Alert } from 'antd'
import { CheckCircleFilled, LoadingOutlined } from '@ant-design/icons'
import { api } from '../../../../lib/api'
import { CodeSnippet } from '../../../../components/setup/CodeSnippet'

export const Route = createFileRoute('/_authenticated/workspaces/$workspaceId/install-sdk')({
  component: InstallSDK
})

function InstallSDK() {
  const { workspaceId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [eventDetected, setEventDetected] = useState(false)
  const [skipping, setSkipping] = useState(false)

  const checkEvents = useCallback(async () => {
    if (eventDetected) return

    try {
      const result = await api.analytics.query({
        workspace_id: workspaceId,
        metrics: ['sessions'],
        dateRange: { preset: 'all_time' }
      })

      // Check data array for session count
      if (result.data && Array.isArray(result.data) && result.data.length > 0) {
        const sessions = (result.data[0] as Record<string, unknown>)?.sessions ?? 0
        if (typeof sessions === 'number' && sessions > 0) {
          await api.workspaces.update({ id: workspaceId, status: 'active' })
          setEventDetected(true)
          queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] })
          queryClient.invalidateQueries({ queryKey: ['workspaces'] })
        }
      }
    } catch {
      // Silently ignore errors during polling
    }
  }, [workspaceId, eventDetected, queryClient])

  // Poll for events every 3 seconds
  useEffect(() => {
    if (eventDetected) return

    const interval = setInterval(checkEvents, 3000)
    checkEvents() // initial check

    return () => clearInterval(interval)
  }, [eventDetected, checkEvents])

  const handleSkip = async () => {
    setSkipping(true)
    try {
      await api.workspaces.update({ id: workspaceId, status: 'active' })
      await queryClient.refetchQueries({ queryKey: ['workspaces', workspaceId] })
      await queryClient.refetchQueries({ queryKey: ['workspaces'] })
      await navigate({ to: '/workspaces/$workspaceId', params: { workspaceId } })
    } finally {
      setSkipping(false)
    }
  }

  const handleContinue = () => {
    navigate({ to: '/workspaces/$workspaceId', params: { workspaceId } })
  }

  // Generate the SDK snippet with workspace_id pre-filled
  const sdkSnippet = `<!-- Staminads -->
<script>
window.StaminadsConfig = {
  workspace_id: '${workspaceId}',
  endpoint: '${window.location.origin}'
};
</script>
<script async src="${window.location.origin}/sdk/staminads_${__APP_VERSION__}.min.js"></script>`

  return (
    <div className="flex-1 p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-light text-gray-800 mb-2">Installer le SDK</h1>
        <p className="text-gray-500 mb-8">
          Ajoutez ce snippet de code dans la balise{' '}
          <code className="bg-gray-100 px-1 rounded">&lt;head&gt;</code> ou{' '}
          <code className="bg-gray-100 px-1 rounded">&lt;body&gt;</code> de votre site.
        </p>

        <CodeSnippet code={sdkSnippet} />

        <div className="mt-8">
          {eventDetected ? (
            <Alert
              type="success"
              icon={<CheckCircleFilled />}
              title="Événement détecté !"
              description="Votre SDK fonctionne correctement. Vous pouvez désormais accéder à votre tableau de bord."
              showIcon
            />
          ) : (
            <div className="flex items-center gap-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
              <Spin indicator={<LoadingOutlined style={{ fontSize: 20 }} spin />} />
              <div>
                <div className="font-medium text-blue-900">En attente du premier événement…</div>
                <div className="text-sm text-blue-700">
                  Installez le SDK sur votre site, nous le détecterons automatiquement.
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="mt-8 flex justify-end">
          {eventDetected ? (
            <Button type="primary" size="large" onClick={handleContinue}>
              Accéder au tableau de bord
            </Button>
          ) : (
            <Button type="link" onClick={handleSkip} loading={skipping}>
              ou passer cette étape →
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
