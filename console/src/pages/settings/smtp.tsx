import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Form,
  Input,
  InputNumber,
  Button,
  Alert,
  Typography,
  Divider,
  Space,
  Tag,
  Popconfirm,
  Spin,
  App,
} from 'antd'
import {
  SaveOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  SendOutlined,
} from '@ant-design/icons'
import { api } from '../../lib/api'
import type { SmtpSettings } from '../../types/smtp'

const { Title, Paragraph } = Typography

function PortSecurityHint({ port }: { port: number | null }) {
  if (!port) return null

  let hint = ''
  if (port === 465) {
    hint = 'Utilise TLS implicite (SMTPS)'
  } else if (port === 587) {
    hint = 'Utilise STARTTLS (recommandé)'
  } else if (port === 25) {
    hint = 'Utilise STARTTLS opportuniste'
  } else {
    hint = 'Utilise STARTTLS si disponible'
  }

  return (
    <div className="text-xs text-gray-500 -mt-2 mb-4">
      • {hint}
    </div>
  )
}

interface SmtpPageProps {
  workspaceId: string
}

export function SmtpPage({ workspaceId }: SmtpPageProps) {
  const queryClient = useQueryClient()
  const { message: messageApi } = App.useApp()
  const [form] = Form.useForm()
  const [testEmail, setTestEmail] = useState('')
  const [hasChanges, setHasChanges] = useState(false)
  const watchedPort = Form.useWatch('port', form)

  // Fetch SMTP info (status + settings in one call)
  const { data: smtpInfo, isLoading } = useQuery({
    queryKey: ['smtp-info', workspaceId],
    queryFn: () => api.smtp.info(workspaceId),
    staleTime: 30_000, // Prevent refetch on remount
  })

  const status = smtpInfo?.status
  const settings = smtpInfo?.settings

  // Update settings mutation
  const updateMutation = useMutation({
    mutationFn: (data: SmtpSettings) => api.smtp.update(workspaceId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smtp-info', workspaceId] })
      messageApi.success('Paramètres SMTP enregistrés')
      setHasChanges(false)
    },
    onError: (error: Error) => {
      messageApi.error(error.message)
    },
  })

  // Delete settings mutation
  const deleteMutation = useMutation({
    mutationFn: () => api.smtp.delete(workspaceId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['smtp-info', workspaceId] })
      form.resetFields()
      messageApi.success('Paramètres SMTP supprimés. Retour à la configuration globale.')
      setHasChanges(false)
    },
    onError: (error: Error) => {
      messageApi.error(error.message)
    },
  })

  // Test email mutation
  const testMutation = useMutation({
    mutationFn: (to: string) => api.smtp.test(workspaceId, to),
    onSuccess: (result) => {
      if (result.success) {
        messageApi.success('Email de test envoyé avec succès')
      } else {
        messageApi.error(result.message)
      }
    },
    onError: (error: Error) => {
      messageApi.error(error.message)
    },
  })

  // Set form values when settings load
  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        host: settings.host,
        port: settings.port,
        username: settings.username,
        password: settings.password ? '********' : '',
        from_name: settings.from_name,
        from_email: settings.from_email,
      })
    }
  }, [settings, form])

  const handleSubmit = async () => {
    try {
      const values = await form.validateFields()

      // Build the update payload
      const updateData: SmtpSettings = {
        enabled: true,
        host: values.host,
        port: values.port,
        from_name: values.from_name,
        from_email: values.from_email,
      }

      // Only include username if provided
      if (values.username) {
        updateData.username = values.username
      }

      // Only include password if it's not the masked placeholder
      if (values.password && values.password !== '********') {
        updateData.password = values.password
      }

      updateMutation.mutate(updateData)
    } catch {
      // Form validation failed
    }
  }

  const handleValuesChange = () => {
    setHasChanges(true)
  }

  const handleTestEmail = () => {
    if (!testEmail) {
      messageApi.warning('Veuillez saisir une adresse email de test')
      return
    }
    testMutation.mutate(testEmail)
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spin />
      </div>
    )
  }

  const hasWorkspaceConfig = status?.source === 'workspace'

  return (
    <div className="space-y-6 max-w-xl">
      {/* Status Section */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <Title level={5} className="!mb-0">
            État de la livraison des emails
          </Title>
          {status?.available ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              Configuré
            </Tag>
          ) : (
            <Tag color="error" icon={<CloseCircleOutlined />}>
              Non configuré
            </Tag>
          )}
        </div>

        {status?.source === 'global' && (
          <Alert
            type="info"
            message="Utilisation du SMTP global"
            description={`Les emails sont envoyés via la configuration SMTP par défaut du système${status.from_email ? ` (${status.from_email})` : ''}. Vous pouvez configurer un SMTP personnalisé ci-dessous pour utiliser votre propre serveur d'envoi.`}
            showIcon
            className="mt-4"
          />
        )}
      </div>

      {/* Settings Form */}
      <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
        <Form
          form={form}
          layout="vertical"
          onValuesChange={handleValuesChange}
          initialValues={{
            port: 587,
          }}
        >
          <div className="flex items-end gap-4">
            <Form.Item
              name="host"
              label="Hôte SMTP"
              rules={[{ required: true, message: 'Veuillez saisir l\'hôte SMTP' }]}
              className="flex-1"
            >
              <Input placeholder="smtp.exemple.fr" />
            </Form.Item>

            <Form.Item
              name="port"
              label="Port"
              rules={[{ required: true, message: 'Veuillez saisir le port' }]}
            >
              <InputNumber
                min={1}
                max={65535}
                style={{ width: 80 }}
                placeholder="587"
              />
            </Form.Item>
          </div>
          <PortSecurityHint port={watchedPort} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Form.Item
              name="username"
              label="Identifiant"
            >
              <Input placeholder="identifiant ou email" autoComplete="off" />
            </Form.Item>

            <Form.Item
              name="password"
              label="Mot de passe"
              extra={settings?.password ? "Saisissez un nouveau mot de passe pour le modifier, ou laissez ******** pour conserver l'existant" : undefined}
            >
              <Input.Password placeholder="••••••••" autoComplete="new-password" />
            </Form.Item>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Form.Item
              name="from_name"
              label="Nom expéditeur"
              rules={[{ required: true, message: 'Veuillez saisir le nom expéditeur' }]}
            >
              <Input placeholder="Veridian Analytics" />
            </Form.Item>

            <Form.Item
              name="from_email"
              label="Email expéditeur"
              rules={[
                { required: true, message: 'Veuillez saisir l\'email expéditeur' },
                { type: 'email', message: 'Veuillez saisir un email valide' },
              ]}
            >
              <Input placeholder="noreply@exemple.fr" />
            </Form.Item>
          </div>

          <Divider />

          <div className="flex justify-between items-center">
            <Space>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={handleSubmit}
                loading={updateMutation.isPending}
                disabled={!hasChanges}
              >
                Enregistrer
              </Button>

              {hasWorkspaceConfig && (
                <Popconfirm
                  title="Supprimer les paramètres SMTP"
                  description="Ceci revient à la configuration SMTP globale (si disponible)."
                  onConfirm={() => deleteMutation.mutate()}
                  okText="Supprimer"
                  cancelText="Annuler"
                  okButtonProps={{ danger: true }}
                >
                  <Button
                    danger
                    icon={<DeleteOutlined />}
                    loading={deleteMutation.isPending}
                  >
                    Supprimer le SMTP personnalisé
                  </Button>
                </Popconfirm>
              )}
            </Space>
          </div>
        </Form>
      </div>

      {/* Test Email */}
      {status?.available && (
        <div>
          <Title level={5} className="!mb-4">
            Tester la livraison email
          </Title>
          <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
            <Paragraph type="secondary" className="!mb-4">
              Envoyez un email de test pour vérifier que votre configuration SMTP fonctionne correctement.
            </Paragraph>

            <Space.Compact style={{ width: '100%' }}>
              <Input
                placeholder="Saisissez une adresse email de test"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                type="email"
              />
              <Button
                type="primary"
                icon={<SendOutlined />}
                onClick={handleTestEmail}
                loading={testMutation.isPending}
              >
                Envoyer le test
              </Button>
            </Space.Compact>
          </div>
        </div>
      )}

    </div>
  )
}
