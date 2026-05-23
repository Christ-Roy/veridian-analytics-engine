import { useState, useMemo } from 'react'
import { App, Form, Input, AutoComplete, Switch, Button, Popconfirm, Tooltip } from 'antd'
import { EyeOutlined, EyeInvisibleOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import type { Workspace } from '../../types/workspace'

interface IntegrationsSettingsProps {
  workspace: Workspace
}

const MODEL_SUGGESTIONS = [
  { value: 'claude-opus-4-7', label: 'Claude Opus 4.7 (5 $ / 25 $ par MTok)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (3 $ / 15 $ par MTok)' },
  { value: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (1 $ / 5 $ par MTok)' },
]

// Mask an API key for display (show prefix and last 4 chars)
function maskApiKey(key: string): string {
  if (!key || key.length < 10) return key
  // If already encrypted (contains ':'), just show placeholder
  if (key.includes(':')) return 'sk-ant-••••••••••••••••'
  // Otherwise mask the middle
  const prefix = key.slice(0, 7)
  const suffix = key.slice(-4)
  return `${prefix}${'•'.repeat(16)}${suffix}`
}

export function IntegrationsSettings({ workspace }: IntegrationsSettingsProps) {
  const { message } = App.useApp()
  const queryClient = useQueryClient()
  const [showApiKey, setShowApiKey] = useState(false)

  // Find existing anthropic integration
  const anthropicIntegration = workspace.settings.integrations?.find(
    (i) => i.type === 'anthropic'
  )

  // Derive state from props instead of using useEffect
  const apiKeyPlaceholder = useMemo(() => {
    const hasKey = !!anthropicIntegration?.settings?.api_key_encrypted
    return hasKey ? maskApiKey(anthropicIntegration.settings.api_key_encrypted) : ''
  }, [anthropicIntegration])

  // Use workspace.id as key to force form reset when workspace changes
  const [form] = Form.useForm()
  const [isEnabled, setIsEnabled] = useState(anthropicIntegration?.enabled ?? false)

  // Compute initial form values
  const initialValues = useMemo(() => ({
    model: anthropicIntegration?.settings?.model ?? 'claude-haiku-4-5',
    api_key: '', // Always start empty, user must enter new key to change
  }), [anthropicIntegration?.settings?.model])

  const updateMutation = useMutation({
    mutationFn: api.workspaces.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspace.id] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      message.success('Paramètres d\'intégration enregistrés')
      form.setFieldValue('api_key', '') // Clear after save
    },
    onError: () => {
      message.error('Échec de l\'enregistrement des paramètres d\'intégration')
    },
  })

  const onFinish = (values: { model: string; api_key: string }) => {
    const existingIntegration = anthropicIntegration || {
      id: 'anthropic-1',
      type: 'anthropic' as const,
      enabled: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      settings: {
        api_key_encrypted: '',
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        temperature: 0.7,
      },
      limits: {
        max_requests_per_hour: 60,
        max_tokens_per_day: 100000,
      },
    }

    // Build updated integration
    const updatedIntegration = {
      ...existingIntegration,
      enabled: isEnabled,
      updated_at: new Date().toISOString(),
      settings: {
        ...existingIntegration.settings,
        model: values.model,
        // Only update API key if user provided a new one
        ...(values.api_key ? { api_key_encrypted: values.api_key } : {}),
      },
    }

    // Replace or add the integration
    const otherIntegrations = workspace.settings.integrations?.filter((i) => i.type !== 'anthropic') || []

    updateMutation.mutate({
      id: workspace.id,
      settings: { ...workspace.settings, integrations: [...otherIntegrations, updatedIntegration] },
    })
  }

  const handleToggle = (checked: boolean) => {
    // Don't allow enabling without an API key
    if (checked && !anthropicIntegration?.settings?.api_key_encrypted) {
      message.warning('Veuillez d\'abord ajouter une clé API')
      return
    }

    setIsEnabled(checked)

    // Auto-save enabled state to backend
    // IMPORTANT: Only proceed if we have an existing integration to prevent race conditions
    // where stale data could overwrite the API key
    if (!anthropicIntegration) {
      message.warning('Veuillez d\'abord enregistrer la clé API')
      setIsEnabled(false)
      return
    }

    const updatedIntegration = {
      ...anthropicIntegration,
      enabled: checked,
      updated_at: new Date().toISOString(),
    }

    const otherIntegrations = workspace.settings.integrations?.filter((i) => i.type !== 'anthropic') || []

    updateMutation.mutate({
      id: workspace.id,
      settings: { ...workspace.settings, integrations: [...otherIntegrations, updatedIntegration] },
    })
  }

  return (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-medium">Intégration Anthropic</h2>
        <Tooltip title="Statut">
          <Popconfirm
            title={isEnabled ? 'Désactiver l\'intégration ?' : 'Activer l\'intégration ?'}
            description={isEnabled ? 'L\'assistant IA ne sera plus disponible.' : 'L\'assistant IA deviendra disponible.'}
            onConfirm={() => handleToggle(!isEnabled)}
            okText="Oui"
            cancelText="Non"
          >
            <Switch checked={isEnabled} />
          </Popconfirm>
        </Tooltip>
      </div>

      <Form form={form} layout="vertical" onFinish={onFinish} initialValues={initialValues} key={workspace.id}>
        <Form.Item
          name="api_key"
          label="Clé API"
          extra={apiKeyPlaceholder ? `Actuelle : ${apiKeyPlaceholder}` : 'Aucune clé API configurée'}
        >
          <Input.Password
            placeholder={apiKeyPlaceholder || 'Saisissez votre clé API Anthropic'}
            visibilityToggle={{
              visible: showApiKey,
              onVisibleChange: setShowApiKey,
            }}
            iconRender={(visible) => (visible ? <EyeOutlined /> : <EyeInvisibleOutlined />)}
          />
        </Form.Item>

        <Form.Item
          name="model"
          label="Modèle"
          extra="Sélectionnez une suggestion ou saisissez l'identifiant d'un modèle Anthropic"
        >
          <AutoComplete
            options={MODEL_SUGGESTIONS}
            placeholder="claude-sonnet-4-6"
            filterOption={(input, option) =>
              (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item className="mb-0">
          <Button type="primary" htmlType="submit" loading={updateMutation.isPending}>
            Enregistrer les modifications
          </Button>
        </Form.Item>
      </Form>
    </div>
  )
}
