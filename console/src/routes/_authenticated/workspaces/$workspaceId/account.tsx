import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Form, Input, Button, Table, Tag, Popconfirm, Tooltip, Empty } from 'antd'
import { DeleteOutlined, EditOutlined, PauseCircleOutlined, PlayCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime'
import { z } from 'zod'

dayjs.extend(relativeTime)
import { api } from '../../../../lib/api'
import { useAuth } from '../../../../lib/useAuth'
import { SubscribeDrawer } from '../../../../components/subscriptions/SubscribeDrawer'
import type { Subscription } from '../../../../types/subscription'

const accountSearchSchema = z.object({
  section: z.enum(['profile', 'password', 'email', 'notifications']).optional().default('profile'),
})

type AccountSection = 'profile' | 'password' | 'email' | 'notifications'

export const Route = createFileRoute('/_authenticated/workspaces/$workspaceId/account')({
  component: AccountPage,
  validateSearch: accountSearchSchema,
})

const menuItems: { key: AccountSection; label: string }[] = [
  { key: 'profile', label: 'Profil' },
  { key: 'password', label: 'Changer le mot de passe' },
  { key: 'email', label: 'Changer l\'email' },
  { key: 'notifications', label: 'Notifications' },
]

function AccountPage() {
  const { message } = App.useApp()
  const { workspaceId } = Route.useParams()
  const { section } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { logout, isDemo, publicConfig } = useAuth()

  const { data: user } = useQuery({
    queryKey: ['user'],
    queryFn: api.auth.me,
    enabled: !isDemo,
  })

  // Subscriptions query
  const { data: subscriptions, isLoading: subscriptionsLoading, refetch: refetchSubscriptions } = useQuery({
    queryKey: ['subscriptions', workspaceId],
    queryFn: () => api.subscriptions.list(workspaceId),
    enabled: section === 'notifications',
  })

  // Edit subscription state
  const [editingSubscription, setEditingSubscription] = useState<Subscription | null>(null)

  const setActiveSection = (newSection: AccountSection) => {
    navigate({ to: '/workspaces/$workspaceId/account', params: { workspaceId }, search: { section: newSection } })
  }

  // Profile form
  const [profileForm] = Form.useForm()

  // Set form values when user data loads
  useEffect(() => {
    if (user) {
      profileForm.setFieldsValue({ name: user.name })
    }
  }, [user, profileForm])

  const updateProfileMutation = useMutation({
    mutationFn: api.auth.updateProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] })
      message.success('Profil mis à jour')
    },
    onError: (error: Error) => {
      message.error(error.message || 'Échec de la mise à jour du profil')
    },
  })

  const onProfileSubmit = (values: { name: string }) => {
    updateProfileMutation.mutate({ name: values.name })
  }

  // Password form
  const [passwordForm] = Form.useForm()
  const changePasswordMutation = useMutation({
    mutationFn: ({ currentPassword, newPassword }: { currentPassword: string; newPassword: string }) =>
      api.auth.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      message.success('Mot de passe modifié. Veuillez vous reconnecter.')
      logout()
      navigate({ to: '/login' })
    },
    onError: (error: Error) => {
      message.error(error.message || 'Échec du changement de mot de passe')
    },
  })

  const onPasswordSubmit = (values: { currentPassword: string; newPassword: string; confirmPassword: string }) => {
    if (values.newPassword !== values.confirmPassword) {
      message.error('Les nouveaux mots de passe ne correspondent pas')
      return
    }
    changePasswordMutation.mutate({
      currentPassword: values.currentPassword,
      newPassword: values.newPassword,
    })
  }

  // Email form
  const [emailForm] = Form.useForm()
  const updateEmailMutation = useMutation({
    mutationFn: api.auth.updateProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user'] })
      message.success('Email mis à jour')
      emailForm.resetFields(['newEmail'])
    },
    onError: (error: Error) => {
      message.error(error.message || 'Échec de la mise à jour de l\'email')
    },
  })

  const onEmailSubmit = (values: { newEmail: string }) => {
    updateEmailMutation.mutate({ email: values.newEmail })
  }

  // Subscription mutations
  const pauseSubscription = useMutation({
    mutationFn: (id: string) => api.subscriptions.pause(workspaceId, id),
    onSuccess: () => {
      message.success('Abonnement mis en pause')
      refetchSubscriptions()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const resumeSubscription = useMutation({
    mutationFn: (id: string) => api.subscriptions.resume(workspaceId, id),
    onSuccess: () => {
      message.success('Abonnement réactivé')
      refetchSubscriptions()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const deleteSubscription = useMutation({
    mutationFn: (id: string) => api.subscriptions.delete(workspaceId, id),
    onSuccess: () => {
      message.success('Abonnement supprimé')
      refetchSubscriptions()
    },
    onError: (error: Error) => message.error(error.message),
  })

  const sendNowSubscription = useMutation({
    mutationFn: (id: string) => api.subscriptions.sendNow(workspaceId, id),
    onSuccess: () => {
      message.success('Rapport envoyé !')
      refetchSubscriptions()
    },
    onError: (error: Error) => message.error(error.message),
  })

  // Profile section content
  const profileContent = (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
      <Form
        form={profileForm}
        layout="vertical"
        onFinish={onProfileSubmit}
      >
        <Form.Item
          name="name"
          label="Nom"
          rules={[{ required: true, message: 'Le nom est obligatoire' }]}
        >
          <Input placeholder="Votre nom" />
        </Form.Item>
        <Form.Item className="mb-0">
          <Button
            type="primary"
            htmlType="submit"
            loading={updateProfileMutation.isPending}
          >
            Enregistrer
          </Button>
        </Form.Item>
      </Form>
    </div>
  )

  // Password section content
  const passwordContent = (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
      <Form
        form={passwordForm}
        layout="vertical"
        onFinish={onPasswordSubmit}
      >
        <Form.Item
          name="currentPassword"
          label="Mot de passe actuel"
          rules={[{ required: true, message: 'Le mot de passe actuel est obligatoire' }]}
        >
          <Input.Password placeholder="Entrez le mot de passe actuel" />
        </Form.Item>
        <Form.Item
          name="newPassword"
          label="Nouveau mot de passe"
          rules={[
            { required: true, message: 'Le nouveau mot de passe est obligatoire' },
            { min: 8, message: 'Le mot de passe doit faire au moins 8 caractères' },
          ]}
        >
          <Input.Password placeholder="Entrez le nouveau mot de passe" />
        </Form.Item>
        <Form.Item
          name="confirmPassword"
          label="Confirmer le nouveau mot de passe"
          rules={[
            { required: true, message: 'Veuillez confirmer votre nouveau mot de passe' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('newPassword') === value) {
                  return Promise.resolve()
                }
                return Promise.reject(new Error('Les mots de passe ne correspondent pas'))
              },
            }),
          ]}
        >
          <Input.Password placeholder="Confirmez le nouveau mot de passe" />
        </Form.Item>
        <Form.Item className="mb-0">
          <Button
            type="primary"
            htmlType="submit"
            loading={changePasswordMutation.isPending}
          >
            Changer le mot de passe
          </Button>
        </Form.Item>
      </Form>
    </div>
  )

  // Email section content
  const emailContent = (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
      <Form
        form={emailForm}
        layout="vertical"
        onFinish={onEmailSubmit}
      >
        <Form.Item label="Email actuel">
          <Input value={user?.email || ''} disabled />
        </Form.Item>
        <Form.Item
          name="newEmail"
          label="Nouvel email"
          rules={[
            { required: true, message: 'Le nouvel email est obligatoire' },
            { type: 'email', message: 'Veuillez entrer un email valide' },
          ]}
        >
          <Input placeholder="Entrez le nouvel email" />
        </Form.Item>
        <Form.Item className="mb-0">
          <Button
            type="primary"
            htmlType="submit"
            loading={updateEmailMutation.isPending}
          >
            Mettre à jour l'email
          </Button>
        </Form.Item>
      </Form>
    </div>
  )

  // Notifications section content
  const subscriptionColumns = [
    {
      title: 'Nom',
      dataIndex: 'name',
      key: 'name',
    },
    {
      title: 'Fréquence',
      dataIndex: 'frequency',
      key: 'frequency',
      render: (frequency: string) => {
        const labels: Record<string, string> = {
          daily: 'quotidienne',
          weekly: 'hebdomadaire',
          monthly: 'mensuelle',
        }
        return <span className="capitalize">{labels[frequency] ?? frequency}</span>
      },
    },
    {
      title: 'Statut',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => {
        const labels: Record<string, string> = {
          active: 'actif',
          paused: 'en pause',
          failed: 'échec',
        }
        return (
          <Tag color={status === 'active' ? 'green' : status === 'paused' ? 'orange' : 'red'}>
            {labels[status] ?? status}
          </Tag>
        )
      },
    },
    {
      title: 'Dernier envoi',
      dataIndex: 'last_sent_at',
      key: 'last_sent_at',
      render: (date: string | undefined, record: Subscription) => {
        if (!date || record.last_send_status === 'pending') {
          return <span className="text-gray-400">Jamais</span>
        }
        if (record.last_send_status === 'failed') {
          return (
            <Tooltip title={record.last_error}>
              <span className="text-red-500">{dayjs(date).fromNow()}</span>
            </Tooltip>
          )
        }
        return <span>{dayjs(date).fromNow()}</span>
      },
    },
    {
      title: 'Prochain envoi',
      dataIndex: 'next_send_at',
      key: 'next_send_at',
      render: (date: string | undefined) => {
        if (!date) return <span className="text-gray-400">-</span>
        return <span>{dayjs(date).fromNow()}</span>
      },
    },
    {
      title: '',
      key: 'actions',
      align: 'right' as const,
      render: (_: unknown, record: Subscription) => (
        <div className="flex gap-1 items-center justify-end">
          {record.status === 'active' ? (
            <Popconfirm
              title="Mettre l'abonnement en pause ?"
              description="Vous ne recevrez plus de rapports par email."
              onConfirm={() => pauseSubscription.mutate(record.id)}
              okText="Mettre en pause"
              cancelText="Annuler"
            >
              <Tooltip title="Mettre en pause">
                <Button
                  type="text"
                  size="small"
                  icon={<PauseCircleOutlined />}
                  loading={pauseSubscription.isPending}
                />
              </Tooltip>
            </Popconfirm>
          ) : record.status === 'paused' ? (
            <Popconfirm
              title="Réactiver l'abonnement ?"
              description="Vous recevrez à nouveau les rapports par email."
              onConfirm={() => resumeSubscription.mutate(record.id)}
              okText="Réactiver"
              cancelText="Annuler"
            >
              <Tooltip title="Réactiver">
                <Button
                  type="text"
                  size="small"
                  icon={<PlayCircleOutlined />}
                  loading={resumeSubscription.isPending}
                />
              </Tooltip>
            </Popconfirm>
          ) : null}
          <Tooltip title="Modifier">
            <Button
              type="text"
              size="small"
              icon={<EditOutlined />}
              onClick={() => setEditingSubscription(record)}
            />
          </Tooltip>
          <Popconfirm
            title="Supprimer l'abonnement ?"
            description="Cette action est irréversible."
            onConfirm={() => deleteSubscription.mutate(record.id)}
            okText="Supprimer"
            cancelText="Annuler"
          >
            <Tooltip title="Supprimer">
              <Button
                type="text"
                size="small"
                icon={<DeleteOutlined />}
                loading={deleteSubscription.isPending}
              />
            </Tooltip>
          </Popconfirm>
          <Popconfirm
            title="Envoyer le rapport maintenant ?"
            description="Ceci enverra le rapport immédiatement sur votre email."
            onConfirm={() => sendNowSubscription.mutate(record.id)}
            okText="Envoyer"
            cancelText="Annuler"
          >
            <Button
              size="small"
              type="primary"
              ghost
              loading={sendNowSubscription.isPending}
            >
              Envoyer maintenant
            </Button>
          </Popconfirm>
        </div>
      ),
    },
  ]

  const notificationsContent = (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-medium">Abonnements email</h2>
        <p className="text-sm text-gray-500">
          Gérez vos rapports email périodiques. Créez de nouveaux abonnements depuis le tableau de bord via l'icône cloche.
        </p>
      </div>
      {subscriptionsLoading ? (
        <div className="text-center py-8 text-gray-500">Chargement…</div>
      ) : !subscriptions || subscriptions.length === 0 ? (
        <Empty
          description="Aucun abonnement pour le moment"
          image={Empty.PRESENTED_IMAGE_SIMPLE}
        >
          <p className="text-sm text-gray-500">
            Rendez-vous sur le tableau de bord et cliquez sur l'icône cloche pour créer votre premier abonnement.
          </p>
        </Empty>
      ) : (
        <Table
          className="bg-white rounded-lg shadow-sm"
          columns={subscriptionColumns}
          dataSource={subscriptions}
          rowKey="id"
          pagination={false}
          scroll={{ x: true }}
        />
      )}
    </div>
  )

  // Public demo: the account editor (profile, password, email, notifications)
  // exposes write surfaces tied to the anonymous demo session that have no
  // meaning for a prospect. Render a clean "not available in demo" panel
  // instead — fixes BUG-12.
  if (isDemo) {
    const contactEmail = publicConfig?.contact_email ?? 'robert.brunon@veridian.site'
    const subject = encodeURIComponent('Demande Veridian Analytics')
    const body = encodeURIComponent(
      "Bonjour,\n\nJ'ai vu la démo publique de Veridian Analytics et je souhaite " +
        'en savoir plus / ouvrir un compte.\n\nMerci.',
    )
    const mailto = `mailto:${contactEmail}?subject=${subject}&body=${body}`
    return (
      <div className="flex-1 p-6" data-testid="account-demo-blocked">
        <h1 className="hidden md:block text-2xl font-light text-gray-800 mb-6">Mon compte</h1>
        <div className="bg-white p-8 rounded-lg shadow-sm max-w-2xl border border-gray-200">
          <h2 className="text-xl font-semibold text-gray-800 mb-3">
            Compte non disponible en démo
          </h2>
          <p className="text-gray-600 mb-4">
            Vous explorez actuellement la démo publique de Veridian Analytics.
            La gestion de compte (profil, mot de passe, email, notifications)
            n'est disponible que sur un espace client réel.
          </p>
          <p className="text-gray-600 mb-6">
            Pour ouvrir un compte gratuit en quelques minutes, écrivez-nous —
            aucune carte bancaire n'est demandée.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href={mailto}
              className="inline-flex items-center px-4 py-2 rounded-md bg-[var(--primary)] text-white text-sm font-semibold hover:opacity-90 transition-opacity"
              data-demo-cta="account-page"
            >
              Demander un compte gratuit →
            </a>
            <Button
              onClick={() =>
                navigate({
                  to: '/workspaces/$workspaceId',
                  params: { workspaceId },
                })
              }
            >
              Retour au dashboard
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-6">
      <h1 className="hidden md:block text-2xl font-light text-gray-800 mb-6">Mon compte</h1>

      <div className="flex gap-6">
        {/* Sidebar Menu */}
        <div className="hidden md:block w-56 flex-shrink-0">
          <nav className="space-y-1">
            {menuItems.map((item) => {
              const isActive = section === item.key
              return (
                <button
                  key={item.key}
                  onClick={() => setActiveSection(item.key)}
                  className={`w-full px-3 py-2 rounded-md text-left text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-[var(--primary)] text-white'
                      : 'text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  {item.label}
                </button>
              )
            })}
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1 min-w-0">
          {/* Mobile section selector */}
          <div className="md:hidden mb-4">
            <select
              value={section}
              onChange={(e) => setActiveSection(e.target.value as AccountSection)}
              className="w-full p-2 border border-gray-300 rounded-md"
            >
              {menuItems.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          {section === 'profile' && profileContent}
          {section === 'password' && passwordContent}
          {section === 'email' && emailContent}
          {section === 'notifications' && notificationsContent}
        </div>
      </div>

      {/* Edit subscription drawer */}
      <SubscribeDrawer
        open={!!editingSubscription}
        onClose={() => setEditingSubscription(null)}
        workspaceId={workspaceId}
        subscription={editingSubscription ?? undefined}
        filters={[]}
        timezone="UTC"
      />
    </div>
  )
}
