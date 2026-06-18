import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useSuspenseQuery, useMutation, useQueryClient, useQuery } from '@tanstack/react-query'
import { App, Form, Input, InputNumber, Button, Select, Table, Tag, Modal, Avatar, Spin, Tooltip, Switch } from 'antd'
import { SearchOutlined, EditOutlined, LoadingOutlined, PlusOutlined, InfoCircleOutlined } from '@ant-design/icons'
import {
  PhoneCall,
  Search as SearchIcon,
  Plug,
  Building2,
  Tags,
  Users,
  Puzzle,
  Mail,
  KeyRound,
  ShieldCheck,
  Code2,
  TriangleAlert,
} from 'lucide-react'
import { api } from '../../../../lib/api'
import { workspaceQueryOptions } from '../../../../lib/queries'
import { IntegrationsSettings } from '../../../../components/settings/IntegrationsSettings'
import { TimeScoreDistribution } from '../../../../components/settings/TimeScoreDistribution'
import { TeamSettings } from '../../../../components/settings/TeamSettings'
import { CodeSnippet } from '../../../../components/setup/CodeSnippet'
import { SmtpPage } from '../../../../pages/settings/smtp'
import { ApiKeysPage } from '../../../../pages/settings/api-keys'
import { VoIPSettingsPanel } from '../../../../veridian/settings-panels/voip-panel'
import { SearchConsoleSettingsPanel } from '../../../../veridian/settings-panels/search-console-panel'
import { ConnectorsSettingsPanel } from '../../../../veridian/settings-panels/connectors-panel'
import { buildTrackerSnippet } from '../../../../veridian/snippet'
import { z } from 'zod'

// Vision Veridian 2026-05-25 : pas de sous-route/onglet "Veridian" custom.
// Les seules extensions autorisées dans Settings sont les onglets feature
// dédiés (`voip`, `search-console`). Tout autre onglet "Veridian" générique
// est interdit — l'ancien onglet `veridian` (page settings tenant) a été
// retiré, sa page React archivée dans `console/src/veridian/_archive/`.
const settingsSearchSchema = z.object({
  section: z.enum(['workspace', 'dimensions', 'team', 'integrations', 'smtp', 'api-keys', 'privacy', 'sdk', 'voip', 'search-console', 'connectors', 'danger']).optional().default('workspace'),
})

export const Route = createFileRoute('/_authenticated/workspaces/$workspaceId/settings')({
  component: Settings,
  validateSearch: settingsSearchSchema,
})

const timezoneOptions = [
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'America/New_York (EST)' },
  { value: 'America/Chicago', label: 'America/Chicago (CST)' },
  { value: 'America/Denver', label: 'America/Denver (MST)' },
  { value: 'America/Los_Angeles', label: 'America/Los_Angeles (PST)' },
  { value: 'America/Toronto', label: 'America/Toronto' },
  { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo' },
  { value: 'Europe/London', label: 'Europe/London (GMT)' },
  { value: 'Europe/Paris', label: 'Europe/Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Europe/Berlin (CET)' },
  { value: 'Europe/Amsterdam', label: 'Europe/Amsterdam (CET)' },
  { value: 'Asia/Tokyo', label: 'Asia/Tokyo (JST)' },
  { value: 'Asia/Shanghai', label: 'Asia/Shanghai (CST)' },
  { value: 'Asia/Singapore', label: 'Asia/Singapore (SGT)' },
  { value: 'Asia/Dubai', label: 'Asia/Dubai (GST)' },
  { value: 'Australia/Sydney', label: 'Australia/Sydney (AEST)' },
  { value: 'Pacific/Auckland', label: 'Pacific/Auckland (NZST)' },
]

const currencyOptions = [
  { value: 'USD', label: 'USD - Dollar américain' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - Livre sterling' },
  { value: 'JPY', label: 'JPY - Yen japonais' },
  { value: 'CAD', label: 'CAD - Dollar canadien' },
  { value: 'AUD', label: 'AUD - Dollar australien' },
  { value: 'CHF', label: 'CHF - Franc suisse' },
  { value: 'CNY', label: 'CNY - Yuan chinois' },
  { value: 'INR', label: 'INR - Roupie indienne' },
  { value: 'BRL', label: 'BRL - Real brésilien' },
]

type SettingsSection = 'workspace' | 'dimensions' | 'team' | 'integrations' | 'smtp' | 'api-keys' | 'privacy' | 'sdk' | 'voip' | 'search-console' | 'connectors' | 'danger'

type MenuItem = {
  key: SettingsSection
  label: string
  ownerOnly?: boolean
  icon?: React.ComponentType<{ size?: number; className?: string }>
}

// Icône lucide (taille 14) sur CHAQUE item pour un menu uniforme : les
// features Veridian (voip/search-console/connectors) ne doivent pas ressortir
// du reste du menu — elles se fondent dans le natif.
const menuItems: MenuItem[] = [
  { key: 'workspace', label: 'Espace de travail', icon: Building2 },
  { key: 'dimensions', label: 'Dimensions personnalisées', icon: Tags },
  { key: 'team', label: 'Équipe', icon: Users },
  { key: 'integrations', label: 'Intégrations', icon: Puzzle },
  { key: 'smtp', label: 'Email (SMTP)', icon: Mail },
  { key: 'api-keys', label: 'Clés API', icon: KeyRound },
  { key: 'privacy', label: 'Confidentialité', icon: ShieldCheck },
  { key: 'sdk', label: 'Installer le SDK', icon: Code2 },
  { key: 'voip', label: 'Téléphonie / VoIP', icon: PhoneCall },
  { key: 'search-console', label: 'Search Console', icon: SearchIcon },
  { key: 'connectors', label: 'Connecteurs', icon: Plug },
  { key: 'danger', label: 'Zone dangereuse', ownerOnly: true, icon: TriangleAlert },
]

function Settings() {
  const { message } = App.useApp()
  const { workspaceId } = Route.useParams()
  const { section } = Route.useSearch()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: workspace } = useSuspenseQuery(workspaceQueryOptions(workspaceId))


  // Fetch current user
  const { data: currentUser } = useQuery({
    queryKey: ['user'],
    queryFn: api.auth.me,
  })

  // Fetch members to get current user's role (needed to show owner-only tabs)
  const { data: members = [] } = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.members.list(workspaceId),
  })

  // Get current user's role
  const currentMember = members.find(m => m.user_id === currentUser?.id)
  const userRole = currentMember?.role || 'viewer'
  const isOwner = userRole === 'owner'

  // Check if workspace has sessions
  const { data: sessionCount } = useQuery({
    queryKey: ['workspace-sessions', workspaceId],
    queryFn: async () => {
      const result = await api.analytics.query({
        workspace_id: workspaceId,
        metrics: ['sessions'],
        dateRange: { preset: 'all_time' }
      })
      if (result.data && Array.isArray(result.data) && result.data.length > 0) {
        return (result.data[0] as Record<string, unknown>)?.sessions as number ?? 0
      }
      return 0
    },
    refetchInterval: section === 'sdk' ? 3000 : false, // Poll only when on SDK section
  })

  const setActiveSection = (newSection: SettingsSection) => {
    navigate({ to: '.', search: { section: newSection } })
  }

  const [form] = Form.useForm()
  const [detectingLogo, setDetectingLogo] = useState(false)
  const [editingSlot, setEditingSlot] = useState<number | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [allowedDomains, setAllowedDomains] = useState<string[]>(workspace.settings.allowed_domains || [])
  const [domainInput, setDomainInput] = useState('')
  const [geoEnabled, setGeoEnabled] = useState(workspace.settings.geo_enabled ?? true)
  const [geoStoreCity, setGeoStoreCity] = useState(workspace.settings.geo_store_city ?? true)
  const [geoStoreRegion, setGeoStoreRegion] = useState(workspace.settings.geo_store_region ?? true)
  const [geoCoordinatesPrecision, setGeoCoordinatesPrecision] = useState(workspace.settings.geo_coordinates_precision ?? 2)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  const updateWorkspaceMutation = useMutation({
    mutationFn: api.workspaces.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] })
      queryClient.invalidateQueries({ queryKey: ['workspaces'] })
      message.success('Paramètres de l\'espace de travail enregistrés')
    },
    onError: (error: Error) => {
      message.error(error.message || 'Échec de l\'enregistrement des paramètres')
    },
  })

  const updateLabelMutation = useMutation({
    mutationFn: api.workspaces.update,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['workspaces', workspaceId] })
      setEditingSlot(null)
      message.success('Libellé mis à jour')
    },
    onError: (error: Error) => {
      message.error(error.message || 'Échec de la mise à jour du libellé')
    },
  })

  const deleteWorkspaceMutation = useMutation({
    mutationFn: () => api.workspaces.delete(workspaceId),
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ['workspaces'] })
      message.success('Espace de travail supprimé')
      navigate({ to: '/workspaces' })
    },
    onError: (error: Error) => {
      message.error(error.message || 'Échec de la suppression de l\'espace de travail')
    },
  })

  const onFinish = (values: { name: string; website: string; logo_url?: string; timezone: string; currency: string; timescore_reference?: number; bounce_threshold?: number }) => {
    updateWorkspaceMutation.mutate({
      id: workspaceId,
      name: values.name,
      website: values.website,
      logo_url: values.logo_url,
      timezone: values.timezone,
      currency: values.currency,
      settings: {
        // Preserve all existing settings, only update form-managed fields
        ...workspace.settings,
        timescore_reference: values.timescore_reference,
        bounce_threshold: values.bounce_threshold,
        allowed_domains: allowedDomains.length > 0 ? allowedDomains : undefined,
      },
    })
  }

  const detectLogo = async () => {
    const website = form.getFieldValue('website')
    if (!website) {
      message.warning('Veuillez d\'abord saisir l\'URL du site')
      return
    }

    try {
      setDetectingLogo(true)
      const meta = await api.tools.websiteMeta(website)
      if (meta.logo_url) {
        form.setFieldValue('logo_url', meta.logo_url)
        message.success('Logo détecté')
      } else {
        message.info('Aucun logo trouvé pour ce site')
      }
    } catch {
      message.error('Échec de la détection du logo')
    } finally {
      setDetectingLogo(false)
    }
  }

  // Helper to get labels from custom_dimensions, handling legacy formats
  const getLabels = (): Record<string, string> => {
    const cd = workspace.settings.custom_dimensions
    if (!cd) return {}
    // If it's already a simple label map (Record<string, string>)
    if (typeof cd === 'object' && !Array.isArray(cd)) {
      // Check if values are strings (new format) or objects (old format)
      const firstValue = Object.values(cd)[0]
      if (firstValue === undefined || typeof firstValue === 'string') {
        return cd as Record<string, string>
      }
    }
    // Legacy format or invalid - return empty
    return {}
  }

  const handleEditClick = (slot: number) => {
    const labels = getLabels()
    setEditingSlot(slot)
    setNewLabel(labels[String(slot)] ?? '')
  }

  const handleSaveLabel = () => {
    if (editingSlot === null) return

    const currentLabels = getLabels()
    const updatedLabels = { ...currentLabels }

    if (newLabel.trim()) {
      updatedLabels[String(editingSlot)] = newLabel.trim()
    } else {
      delete updatedLabels[String(editingSlot)]
    }

    updateLabelMutation.mutate({
      id: workspaceId,
      settings: { ...workspace.settings, custom_dimensions: updatedLabels },
    })
  }

  const logoUrl = Form.useWatch('logo_url', form)

  const handleAddDomain = () => {
    const trimmed = domainInput.trim().toLowerCase()
    if (!trimmed) return
    if (allowedDomains.includes(trimmed)) {
      message.warning('Domaine déjà ajouté')
      return
    }
    setAllowedDomains([...allowedDomains, trimmed])
    setDomainInput('')
  }

  const handleRemoveDomain = (domain: string) => {
    setAllowedDomains(allowedDomains.filter(d => d !== domain))
  }

  const savePrivacySettings = () => {
    updateWorkspaceMutation.mutate({
      id: workspaceId,
      settings: {
        ...workspace.settings,
        geo_enabled: geoEnabled,
        geo_store_city: geoStoreCity,
        geo_store_region: geoStoreRegion,
        geo_coordinates_precision: geoCoordinatesPrecision,
      },
    })
  }

  const workspaceContent = (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
        <Form
          form={form}
          layout="vertical"
          onFinish={onFinish}
          initialValues={{
            name: workspace.name,
            website: workspace.website,
            logo_url: workspace.logo_url,
            timezone: workspace.timezone,
            currency: workspace.currency,
            timescore_reference: workspace.settings.timescore_reference,
            bounce_threshold: workspace.settings.bounce_threshold ?? 10,
          }}
        >
          <Form.Item
            name="name"
            label="Nom de l'espace de travail"
            rules={[{ required: true, message: 'Le nom est obligatoire' }]}
          >
            <Input placeholder="Mon site" />
          </Form.Item>

          <Form.Item
            name="website"
            label="URL du site web"
            rules={[
              { required: true, message: 'Le site est obligatoire' },
              { type: 'url', message: 'L\'URL doit être valide' },
            ]}
          >
            <Input placeholder="https://exemple.fr" />
          </Form.Item>

          <Form.Item name="logo_url" label="URL du logo">
            <Input
              placeholder="https://example.com/logo.png"
              suffix={
                <Button
                  type="link"
                  size="small"
                  icon={<SearchOutlined />}
                  loading={detectingLogo}
                  onClick={detectLogo}
                  className="!p-0 !h-auto"
                >
                  Détecter
                </Button>
              }
              prefix={
                logoUrl ? (
                  <Avatar src={logoUrl} size="small" shape="square" className="mr-1" />
                ) : null
              }
            />
          </Form.Item>

          <Form.Item name="timezone" label="Fuseau horaire">
            <Select
              options={timezoneOptions}
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Form.Item name="currency" label="Devise">
            <Select
              options={currencyOptions}
              showSearch
              filterOption={(input, option) =>
                (option?.label ?? '').toLowerCase().includes(input.toLowerCase())
              }
            />
          </Form.Item>

          <Form.Item
            name="timescore_reference"
            label="Référence TimeScore (secondes)"
            tooltip="Durée médiane cible des visites pour la coloration de la heat map dans Explorer. Une valeur plus élevée = barre plus haute pour l'engagement « vert »."
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>

          <div className="mb-6 -mt-2">
            <TimeScoreDistribution
              workspaceId={workspaceId}
              timescoreReference={workspace.settings.timescore_reference ?? 60}
            />
          </div>

          <Form.Item
            name="bounce_threshold"
            label="Seuil de rebond (secondes)"
            tooltip="Les visites plus courtes que cette durée sont comptées comme rebonds. Valeur par défaut : 10 secondes."
          >
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item
            label={
              <span>
                Domaines autorisés{' '}
                <Tooltip title="Restreint le tracking à des domaines spécifiques. Laissez vide pour autoriser tous les domaines. Accepte les jokers comme *.exemple.fr">
                  <InfoCircleOutlined className="text-gray-400" />
                </Tooltip>
              </span>
            }
          >
            <div className="space-y-2">
              <Input
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                placeholder="exemple.fr ou *.exemple.fr"
                onPressEnter={(e) => {
                  e.preventDefault()
                  handleAddDomain()
                }}
                suffix={
                  <Button
                    type="link"
                    size="small"
                    icon={<PlusOutlined />}
                    onClick={handleAddDomain}
                    className="!p-0 !h-auto"
                  >
                    Ajouter
                  </Button>
                }
              />
              {allowedDomains.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {allowedDomains.map((domain) => (
                    <Tag
                      key={domain}
                      closable
                      onClose={() => handleRemoveDomain(domain)}
                    >
                      {domain}
                    </Tag>
                  ))}
                </div>
              )}
              {allowedDomains.length === 0 && (
                <div className="text-gray-400 text-sm">Tous les domaines sont autorisés (aucune restriction)</div>
              )}
            </div>
          </Form.Item>

          <Form.Item className="mb-0">
            <Button
              type="primary"
              htmlType="submit"
              loading={updateWorkspaceMutation.isPending}
            >
              Enregistrer les modifications
            </Button>
          </Form.Item>
        </Form>
    </div>
  )

  // Get labels from workspace (using helper to handle legacy formats)
  const labels = getLabels()

  // Generate all 10 slots
  const allSlots = Array.from({ length: 10 }, (_, i) => {
    const slot = i + 1
    return {
      slot,
      label: labels[String(slot)] ?? null,
    }
  })

  const dimensionsContent = (
    <div className="bg-white rounded-lg shadow-sm max-w-xl">
        <Table
          dataSource={allSlots}
          rowKey="slot"
          pagination={false}
          columns={[
            {
              title: 'Emplacement',
              dataIndex: 'slot',
              key: 'slot',
              width: 100,
              render: (slot: number) => <Tag color="purple">stm_{slot}</Tag>,
            },
            {
              title: 'Libellé',
              dataIndex: 'label',
              key: 'label',
              render: (label: string | null) => (
                <span className={label ? 'font-medium' : 'text-gray-400 italic'}>
                  {label || '(vide)'}
                </span>
              ),
            },
            {
              title: 'Actions',
              key: 'actions',
              width: 100,
              render: (_, record) => (
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => handleEditClick(record.slot)}
                >
                  Modifier
                </Button>
              ),
            },
          ]}
        />

        <Modal
          title="Modifier le libellé de la dimension"
          open={editingSlot !== null}
          onCancel={() => setEditingSlot(null)}
          onOk={handleSaveLabel}
          confirmLoading={updateLabelMutation.isPending}
          okText="Enregistrer"
          cancelText="Annuler"
        >
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Emplacement</label>
              <Input value={`stm_${editingSlot}`} disabled />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Libellé</label>
              <Input
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Saisissez le libellé de la dimension (laissez vide pour effacer)"
              />
            </div>
          </div>
        </Modal>
    </div>
  )

  // Snippet généré depuis la source unique (cf. veridian/snippet.ts) — pointe
  // sur /sdk/v1/tracker.js (le seul chemin servi par le backend SdkController).
  const sdkSnippet = buildTrackerSnippet({
    workspaceId,
    endpoint: window.location.origin,
  })

  const sdkContent = (
    <div className="max-w-xl">
      <CodeSnippet code={sdkSnippet} />
      <p className="text-gray-500 mt-4">
        Ajoutez ce snippet de code dans la balise <code>&lt;head&gt;</code> ou <code>&lt;body&gt;</code> de votre site.
      </p>
      {sessionCount === 0 && (
        <div className="mt-6 flex items-center gap-3 p-4 bg-blue-50 rounded-lg border border-blue-200">
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
  )

  const privacyContent = (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl">
      <h3 className="text-lg font-medium mb-4">Collecte de données géographiques</h3>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="font-medium">Activer le tracking de géolocalisation</div>
            <div className="text-sm text-gray-500">Enregistrer le pays, la région, la ville et les coordonnées des visiteurs</div>
          </div>
          <Switch checked={geoEnabled} onChange={setGeoEnabled} />
        </div>

        {geoEnabled && (
          <div className="ml-6 border-l-2 border-gray-100 pl-4 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Enregistrer le nom de la ville</div>
                <div className="text-sm text-gray-500">Enregistrer la ville des visiteurs</div>
              </div>
              <Switch checked={geoStoreCity} onChange={setGeoStoreCity} />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Enregistrer le nom de la région</div>
                <div className="text-sm text-gray-500">Enregistrer la région ou le département des visiteurs</div>
              </div>
              <Switch checked={geoStoreRegion} onChange={setGeoStoreRegion} />
            </div>

            <div>
              <div className="font-medium mb-1">Précision des coordonnées</div>
              <div className="text-sm text-gray-500 mb-2">Précision plus faible = davantage de confidentialité</div>
              <Select
                value={geoCoordinatesPrecision}
                onChange={setGeoCoordinatesPrecision}
                style={{ width: '100%' }}
                options={[
                  { value: 0, label: 'Niveau pays (précision ~111 km)' },
                  { value: 1, label: 'Régional (précision ~11 km)' },
                  { value: 2, label: 'Niveau ville (précision ~1 km)' },
                ]}
              />
            </div>
          </div>
        )}
      </div>

      <div className="mt-6 p-3 bg-blue-50 rounded text-sm text-blue-700">
        Les adresses IP ne sont jamais stockées — uniquement utilisées pour la résolution géographique. Le pays est toujours inclus lorsque le tracking géo est activé.
      </div>

      <div className="mt-6">
        <Button
          type="primary"
          onClick={savePrivacySettings}
          loading={updateWorkspaceMutation.isPending}
        >
          Enregistrer les modifications
        </Button>
      </div>
    </div>
  )

  const dangerContent = (
    <div className="bg-white p-6 rounded-lg shadow-sm max-w-xl border border-red-200">
      <h3 className="text-lg font-medium text-red-600 mb-4">Supprimer l'espace de travail</h3>
      <p className="text-gray-600 mb-4">
        Une fois l'espace de travail supprimé, l'action est irréversible. Toutes les données
        analytics, membres de l'équipe, clés API et paramètres seront supprimés définitivement.
      </p>
      <Button danger onClick={() => setDeleteConfirmOpen(true)}>
        Supprimer cet espace de travail
      </Button>

      <Modal
        title="Supprimer l'espace de travail"
        open={deleteConfirmOpen}
        onCancel={() => {
          setDeleteConfirmOpen(false)
          setDeleteConfirmText('')
        }}
        footer={[
          <Button key="cancel" onClick={() => {
            setDeleteConfirmOpen(false)
            setDeleteConfirmText('')
          }}>
            Annuler
          </Button>,
          <Button
            key="delete"
            danger
            type="primary"
            loading={deleteWorkspaceMutation.isPending}
            disabled={deleteConfirmText !== workspace.name}
            onClick={() => deleteWorkspaceMutation.mutate()}
          >
            Supprimer
          </Button>,
        ]}
      >
        <p className="mb-4">
          Cette action est irréversible. L'espace de travail
          <strong> {workspace.name}</strong> et toutes ses données seront supprimés définitivement.
        </p>
        <p className="mb-2">Veuillez saisir <strong>{workspace.name}</strong> pour confirmer :</p>
        <Input
          value={deleteConfirmText}
          onChange={(e) => setDeleteConfirmText(e.target.value)}
          placeholder={workspace.name}
        />
      </Modal>
    </div>
  )

  return (
    <div className="flex-1 p-6">
      <h1 className="hidden md:block text-2xl font-light text-gray-800 mb-6">Paramètres</h1>

      <div className="flex gap-6">
        {/* Sidebar Menu - hidden on mobile, accessible via hamburger menu */}
        <div className="hidden md:block w-56 flex-shrink-0">
          <nav className="space-y-1">
            {menuItems
              .filter((item) => !item.ownerOnly || isOwner)
              .map((item) => {
                const isActive = section === item.key
                const Icon = item.icon
                return (
                  <button
                    key={item.key}
                    onClick={() => setActiveSection(item.key)}
                    className={`w-full px-3 py-2 rounded-md text-left text-sm font-medium transition-colors flex items-center gap-2 ${
                      isActive
                        ? 'bg-[var(--primary)] text-white'
                        : 'text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    {Icon && <Icon size={14} className="shrink-0" />}
                    <span>{item.label}</span>
                  </button>
                )
              })}
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1 min-w-0">
          {section === 'workspace' && workspaceContent}
          {section === 'dimensions' && dimensionsContent}
          {section === 'team' && <TeamSettings workspaceId={workspaceId} userRole={userRole} />}
          {section === 'integrations' && <IntegrationsSettings workspace={workspace} />}
          {section === 'smtp' && <SmtpPage workspaceId={workspaceId} />}
          {section === 'api-keys' && <ApiKeysPage workspaceId={workspaceId} />}
          {section === 'privacy' && privacyContent}
          {section === 'sdk' && sdkContent}
          {section === 'voip' && (
            <VoIPSettingsPanel workspaceId={workspaceId} />
          )}
          {section === 'search-console' && (
            <SearchConsoleSettingsPanel
              workspaceId={workspaceId}
              siteDomain={workspace.website || undefined}
            />
          )}
          {section === 'connectors' && (
            <ConnectorsSettingsPanel workspaceId={workspaceId} />
          )}
          {section === 'danger' && isOwner && dangerContent}
        </div>
      </div>
    </div>
  )
}
