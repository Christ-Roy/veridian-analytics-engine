import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  App,
  Alert,
  Button,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd'
import {
  PhoneOutlined,
  NumberOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
  DeleteOutlined,
  EditOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons'
import {
  fetchVoipSettings,
  saveCredential,
  testCredential,
  deleteCredential,
  fetchPhoneNumbers,
  createPhoneNumber,
  updatePhoneNumber,
  deletePhoneNumber,
  syncNow,
  VoipApiError,
} from './voip-api'
import type {
  VoipSettingsResponse,
  VoipCredentialKind as CredentialKind,
  CredentialView,
  PhoneSource,
  TrackedPhoneNumber,
} from './voip-api'

const { Title, Text, Paragraph } = Typography

/**
 * Labels FR (vouvoiement) pour les 7 sources de trafic. La liste autorisée
 * est servie par l'engine (`allowedSources`) — on garde un fallback `direct`
 * si une nouvelle valeur arrive non-mappée.
 */
const SOURCE_LABELS: Record<PhoneSource, string> = {
  seo: 'SEO (référencement naturel)',
  ads: 'Ads (Google / Bing / Meta)',
  direct: 'Direct (saisi sur le site)',
  email: 'Email / Newsletter',
  social: 'Réseaux sociaux',
  print: 'Print (flyers / cartes de visite)',
  other: 'Autre',
}

/** Couleur de Tag AntD par source (préset clair, cohérent fond blanc). */
const SOURCE_TAG_COLOR: Record<PhoneSource, string> = {
  seo: 'green',
  ads: 'gold',
  direct: 'blue',
  email: 'purple',
  social: 'magenta',
  print: 'orange',
  other: 'default',
}

/**
 * Texte canonique du secret write-only (aligné sur le panel Connecteurs).
 * Les identifiants sont chiffrés côté engine et ne sont jamais réaffichés.
 */
const SECRET_NOTICE =
  'Vos identifiants sont chiffrés (AES-256-GCM) avant stockage. Ils ne sont jamais réaffichés en clair.'

/**
 * VoIPSettingsPanel — onglet « Téléphonie / VoIP » dans Settings native.
 *
 * Onglet dédié dans la sidebar Settings staminads (z.enum `'voip'`). C'est la
 * SEULE entrée d'accès à la gestion de la téléphonie : il n'y a pas de page
 * `/calls` dédiée, les appels remontent comme événements `phone_call` dans
 * les vues natives staminads (Live, Explore, Goals).
 *
 * Port natif (ticket 2026-06-16) : ce panel consomme les endpoints NATIFS de
 * l'engine (`/api/voip.*`, auth session console). Il ne gère que la CONFIG —
 * connecter OVH/Telnyx, mapper numéros→sources, voir le statut de synchro —
 * JAMAIS une liste d'appels (vision Robert 2026-05-23).
 *
 * Présentation : Ant Design natif (fond clair, primaire violet console), pour
 * se fondre dans les autres panels Settings (cf TeamSettings / api-keys).
 *
 * Sections :
 *   1. Choix opérateur (OVH / Telnyx) + formulaire credentials chiffrés (AES-256-GCM)
 *   2. Liste des credentials enregistrés (masqués) + bouton Tester / Supprimer
 *   3. Numéros trackés (1 numéro = 1 source de trafic) + lien vers Live/Explore
 *
 * Sécurité : la page n'affiche JAMAIS les credentials en clair — l'API ne
 * renvoie que des valeurs masquées (`••••1234`). La saisie d'un nouveau
 * credential remplace l'ancien (les champs sont vidés après envoi).
 */

export interface VoIPSettingsPanelProps {
  workspaceId: string
}

const VOIP_PROVIDERS: Array<{
  kind: CredentialKind
  label: string
  fields: Array<{ name: string; label: string; placeholder: string }>
}> = [
  {
    kind: 'voip_ovh',
    label: 'OVH Telephony',
    fields: [
      {
        name: 'applicationKey',
        label: 'Application Key',
        placeholder: 'Clé application OVH',
      },
      {
        name: 'applicationSecret',
        label: 'Application Secret',
        placeholder: 'Secret application OVH',
      },
      {
        name: 'consumerKey',
        label: 'Consumer Key',
        placeholder: 'Consumer key OVH',
      },
    ],
  },
  {
    kind: 'voip_telnyx',
    label: 'Telnyx',
    fields: [{ name: 'apiKey', label: 'API Key', placeholder: 'KEY...' }],
  },
]

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: VoipSettingsResponse }

export function VoIPSettingsPanel({ workspaceId }: VoIPSettingsPanelProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setState({ kind: 'loading' })
    fetchVoipSettings(workspaceId, { signal: ctrl.signal })
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ kind: 'ready', data })
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return
        setState({ kind: 'error', error: err })
      })
  }, [workspaceId])

  useEffect(() => {
    load()
    return () => abortRef.current?.abort()
  }, [load])

  return (
    <div data-testid="voip-settings-panel" className="space-y-6">
      {state.kind === 'loading' && (
        <div
          className="flex justify-center py-16"
          data-testid="voip-panel-skeleton"
        >
          <Spin size="large" tip="Chargement des paramètres VoIP…">
            <div className="h-24 w-24" />
          </Spin>
        </div>
      )}
      {state.kind === 'error' && (
        <Alert
          type="error"
          showIcon
          message="Impossible de charger les paramètres VoIP"
          description={state.error.message}
          data-testid="voip-panel-error"
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>
              Réessayer
            </Button>
          }
        />
      )}
      {state.kind === 'ready' && (
        <VoipContent
          workspaceId={workspaceId}
          credentials={state.data.credentials}
          onRefresh={load}
        />
      )}
    </div>
  )
}

function VoipContent({
  workspaceId,
  credentials,
  onRefresh,
}: {
  workspaceId: string
  credentials: CredentialView[]
  onRefresh: () => void
}) {
  const [provider, setProvider] = useState<CredentialKind>('voip_ovh')
  const def = useMemo(
    () => VOIP_PROVIDERS.find((p) => p.kind === provider)!,
    [provider],
  )

  const hasConnectedCred = credentials.some((c) => c.status === 'ok')

  return (
    <>
      {/* Section opérateur + credentials */}
      <section
        className="bg-white p-6 rounded-lg shadow-sm"
        data-testid="settings-section-voip"
      >
        <div className="flex items-start gap-3 mb-4">
          <PhoneOutlined className="text-xl mt-1 text-gray-500" />
          <div>
            <Title level={5} className="!mb-1">
              Téléphonie / VoIP
            </Title>
            <Text type="secondary">
              Branchez votre opérateur pour remonter vos appels dans Veridian.
              Les appels apparaîtront dans la vue En direct et dans Explorer.
            </Text>
          </div>
        </div>

        {/* Credentials déjà enregistrés */}
        {credentials.length > 0 && (
          <div className="space-y-3 mb-5" data-testid="voip-credentials-list">
            {credentials.map((cred) => (
              <CredentialCard
                key={cred.kind}
                workspaceId={workspaceId}
                cred={cred}
                onChanged={onRefresh}
              />
            ))}
          </div>
        )}

        {/* Formulaire d'ajout / remplacement */}
        <div className="rounded-lg border border-dashed border-gray-200 p-4">
          <Form layout="vertical">
            <Form.Item label="Opérateur" className="!mb-3">
              <Select
                value={provider}
                onChange={(v) => setProvider(v as CredentialKind)}
                options={VOIP_PROVIDERS.map((p) => ({
                  value: p.kind,
                  label: p.label,
                }))}
                data-testid="voip-provider-select"
              />
            </Form.Item>
          </Form>
          <CredentialForm
            key={provider}
            workspaceId={workspaceId}
            kind={def.kind}
            fields={def.fields}
            onSaved={onRefresh}
          />
        </div>
      </section>

      {/* Sous-section "Numéros trackés" — 1 numéro = 1 source de trafic */}
      <TrackedNumbersSection workspaceId={workspaceId} />

      {/* Synchro manuelle + rappel : où voir les appels (vues natives) */}
      {hasConnectedCred && (
        <CallsHint workspaceId={workspaceId} onRefresh={onRefresh} />
      )}
    </>
  )
}

// ─── Numéros trackés (phone source dimension, 2026-05-25) ───────────────
//
// 1 numéro = 1 source de trafic. L'engine enrichit chaque event `phone_call`
// poussé en interne avec `properties.source` (SEO / Ads / direct / email
// / social / print / other) après lookup `(workspace, toNumber)`. Les appels
// apparaissent dans Live/Explore/Goals staminads natifs, sans page custom.

type TrackedState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; rows: TrackedPhoneNumber[]; allowedSources: PhoneSource[] }

function TrackedNumbersSection({ workspaceId }: { workspaceId: string }) {
  const { message } = App.useApp()
  const [state, setState] = useState<TrackedState>({ kind: 'loading' })
  const [editing, setEditing] = useState<{
    mode: 'create' | 'edit'
    row?: TrackedPhoneNumber
  } | null>(null)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    fetchPhoneNumbers(workspaceId)
      .then((res) =>
        setState({
          kind: 'ready',
          rows: res.phoneNumbers,
          allowedSources: res.allowedSources,
        }),
      )
      .catch((err: Error) => setState({ kind: 'error', error: err }))
  }, [workspaceId])

  useEffect(() => {
    load()
  }, [load])

  const handleDelete = useCallback(
    async (row: TrackedPhoneNumber) => {
      try {
        await deletePhoneNumber(workspaceId, row.id)
        message.success('Numéro supprimé')
        load()
      } catch (err) {
        message.error(
          err instanceof VoipApiError ? err.message : 'Suppression impossible.',
        )
      }
    },
    [workspaceId, load, message],
  )

  const columns = [
    {
      title: 'Numéro',
      dataIndex: 'e164',
      key: 'e164',
      render: (e164: string) => (
        <span className="font-mono tabular-nums">{e164}</span>
      ),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 220,
      render: (source: PhoneSource) => (
        <Tag color={SOURCE_TAG_COLOR[source] ?? 'default'}>
          {SOURCE_LABELS[source] ?? source}
        </Tag>
      ),
    },
    {
      title: 'Libellé',
      dataIndex: 'label',
      key: 'label',
      render: (label: string | null) =>
        label ? label : <Text type="secondary">—</Text>,
    },
    {
      title: '',
      key: 'actions',
      width: 90,
      align: 'right' as const,
      render: (_: unknown, row: TrackedPhoneNumber) => (
        <Space size={0}>
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            aria-label="Modifier"
            onClick={() => setEditing({ mode: 'edit', row })}
            data-testid={`phone-numbers-edit-${row.id}`}
          />
          <Popconfirm
            title="Supprimer le numéro"
            description="Cette action est irréversible."
            onConfirm={() => handleDelete(row)}
            okText="Supprimer"
            cancelText="Annuler"
            okButtonProps={{ danger: true }}
          >
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              aria-label="Supprimer"
              data-testid={`phone-numbers-delete-${row.id}`}
            />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <section
      className="bg-white p-6 rounded-lg shadow-sm"
      data-testid="settings-section-phone-numbers"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-start gap-3">
          <NumberOutlined className="text-xl mt-1 text-gray-500" />
          <div>
            <Title level={5} className="!mb-1">
              Numéros trackés
            </Title>
            <Text type="secondary">
              Associez chaque numéro de téléphone affiché sur vos supports à sa
              source. Par exemple : votre numéro SEO sur le site web →
              «&nbsp;SEO&nbsp;», votre numéro Google Ads → «&nbsp;Ads&nbsp;».
              Chaque appel sera automatiquement attribué à sa source dans les
              goals.
            </Text>
          </div>
        </div>
        {state.kind === 'ready' && state.rows.length > 0 && (
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setEditing({ mode: 'create' })}
            data-testid="phone-numbers-add-btn"
          >
            <span className="hidden md:inline">Ajouter un numéro</span>
            <span className="md:hidden">Ajouter</span>
          </Button>
        )}
      </div>

      {state.kind === 'loading' && (
        <div className="flex justify-center py-8">
          <Spin />
        </div>
      )}

      {state.kind === 'error' && (
        <Alert
          type="error"
          showIcon
          message="Impossible de charger les numéros"
          description={state.error.message}
          action={
            <Button size="small" icon={<ReloadOutlined />} onClick={load}>
              Réessayer
            </Button>
          }
        />
      )}

      {state.kind === 'ready' && (
        <>
          {state.rows.length === 0 ? (
            <div className="py-4" data-testid="phone-numbers-empty">
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  <span className="text-gray-500">
                    Aucun numéro tracké pour le moment. Tant qu'un numéro n'est
                    pas associé à une source, ses appels seront comptabilisés
                    comme «&nbsp;direct&nbsp;».
                  </span>
                }
              >
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setEditing({ mode: 'create' })}
                >
                  Ajouter votre premier numéro
                </Button>
              </Empty>
            </div>
          ) : (
            <>
              {/* Mobile : cartes */}
              <div className="md:hidden space-y-3">
                {state.rows.map((row) => (
                  <div
                    key={row.id}
                    className="rounded-lg border border-gray-200 p-4"
                    data-testid={`phone-numbers-row-${row.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-mono tabular-nums font-medium">
                        {row.e164}
                      </span>
                      <Tag color={SOURCE_TAG_COLOR[row.source] ?? 'default'}>
                        {SOURCE_LABELS[row.source] ?? row.source}
                      </Tag>
                    </div>
                    {row.label && (
                      <div className="text-gray-500 text-sm mt-1">
                        {row.label}
                      </div>
                    )}
                    <div className="flex gap-2 mt-3 pt-3 border-t border-gray-100">
                      <Button
                        block
                        size="small"
                        icon={<EditOutlined />}
                        onClick={() => setEditing({ mode: 'edit', row })}
                      >
                        Modifier
                      </Button>
                      <Popconfirm
                        title="Supprimer le numéro"
                        description="Cette action est irréversible."
                        onConfirm={() => handleDelete(row)}
                        okText="Supprimer"
                        cancelText="Annuler"
                        okButtonProps={{ danger: true }}
                      >
                        <Button block size="small" icon={<DeleteOutlined />}>
                          Supprimer
                        </Button>
                      </Popconfirm>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop : table */}
              <div
                className="hidden md:block"
                data-testid="phone-numbers-table"
              >
                <Table
                  dataSource={state.rows}
                  columns={columns}
                  rowKey="id"
                  pagination={false}
                  size="small"
                />
              </div>
            </>
          )}

          {editing && (
            <PhoneNumberModal
              workspaceId={workspaceId}
              mode={editing.mode}
              row={editing.row}
              allowedSources={state.allowedSources}
              onClose={() => setEditing(null)}
              onSaved={() => {
                setEditing(null)
                load()
              }}
            />
          )}
        </>
      )}
    </section>
  )
}

interface PhoneNumberFormValues {
  e164: string
  source: PhoneSource
  label?: string
}

function PhoneNumberModal({
  workspaceId,
  mode,
  row,
  allowedSources,
  onClose,
  onSaved,
}: {
  workspaceId: string
  mode: 'create' | 'edit'
  row?: TrackedPhoneNumber
  allowedSources: PhoneSource[]
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<PhoneNumberFormValues>()
  const [saving, setSaving] = useState(false)

  const submit = useCallback(
    async (values: PhoneNumberFormValues) => {
      setSaving(true)
      try {
        if (mode === 'create') {
          await createPhoneNumber(workspaceId, {
            e164: values.e164.trim(),
            source: values.source,
            label: values.label?.trim() || null,
          })
          message.success('Numéro ajouté')
        } else if (row) {
          await updatePhoneNumber(workspaceId, row.id, {
            source: values.source,
            label: values.label?.trim() || null,
          })
          message.success('Numéro mis à jour')
        }
        onSaved()
      } catch (err) {
        if (err instanceof VoipApiError) {
          if (err.code === 'invalid_e164') {
            message.error(
              'Format de numéro invalide. Saisissez un numéro E.164, par exemple +33177123456.',
            )
          } else if (err.code === 'already_exists') {
            message.error('Ce numéro est déjà enregistré pour ce workspace.')
          } else {
            message.error(err.message)
          }
        } else {
          message.error('Enregistrement impossible.')
        }
      } finally {
        setSaving(false)
      }
    },
    [mode, row, workspaceId, onSaved, message],
  )

  return (
    <Modal
      open
      title={mode === 'create' ? 'Ajouter un numéro' : 'Modifier le numéro'}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={saving}
      okText={mode === 'create' ? 'Ajouter' : 'Enregistrer'}
      cancelText="Annuler"
      data-testid="phone-numbers-modal"
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        className="mt-4"
        initialValues={{
          e164: row?.e164 ?? '',
          source: row?.source ?? 'seo',
          label: row?.label ?? '',
        }}
      >
        <Form.Item
          name="e164"
          label="Numéro (E.164)"
          rules={[{ required: true, message: 'Le numéro est obligatoire' }]}
          extra={
            mode === 'edit'
              ? 'Le numéro ne peut pas être modifié. Pour le changer, supprimez puis recréez l\'entrée.'
              : undefined
          }
        >
          <Input
            type="tel"
            placeholder="+33177123456"
            disabled={mode === 'edit'}
            className="font-mono"
            data-testid="phone-numbers-field-e164"
          />
        </Form.Item>

        <Form.Item
          name="source"
          label="Source"
          rules={[{ required: true, message: 'La source est obligatoire' }]}
        >
          <Select
            options={allowedSources.map((s) => ({
              value: s,
              label: SOURCE_LABELS[s] ?? s,
            }))}
            data-testid="phone-numbers-field-source"
          />
        </Form.Item>

        <Form.Item
          name="label"
          label="Libellé (optionnel)"
          rules={[{ max: 120, message: 'Le libellé doit faire 120 caractères maximum' }]}
        >
          <Input
            placeholder="Ligne SEO, campagne été…"
            maxLength={120}
            data-testid="phone-numbers-field-label"
          />
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Synchro manuelle + où voir les appels (vues natives, PAS de liste) ────
//
// Vision Robert 2026-05-23 : pas de page Calls, pas de liste d'appels dans
// Settings. Les appels sont des events `phone_call` natifs → on pointe juste
// l'opérateur vers Live / Explore où ils apparaissent comme n'importe quel
// goal, filtrables par dimension `source`.
//
// Le bouton « Synchroniser maintenant » force une remontée immédiate (le cron
// natif ne tourne que toutes les 15 min, et uniquement si `VOIP_SYNC_ENABLED`
// est activé sur l'instance). C'est la boucle de validation « ça marche »
// juste après avoir connecté un opérateur et mappé ses numéros.

function CallsHint({
  workspaceId,
  onRefresh,
}: {
  workspaceId: string
  onRefresh: () => void
}) {
  const { message } = App.useApp()
  const [syncing, setSyncing] = useState(false)

  const runSync = useCallback(async () => {
    setSyncing(true)
    try {
      const r = await syncNow(workspaceId)
      const n = r.pushedEvents
      message.success(
        n === 0
          ? 'Synchro terminée : aucun nouvel appel à remonter.'
          : `Synchro terminée : ${n} appel${n > 1 ? 's' : ''} remonté${
              n > 1 ? 's' : ''
            }.`,
      )
      // Rafraîchit le panel pour mettre à jour « Dernière synchro ».
      onRefresh()
    } catch (err) {
      message.error(
        err instanceof VoipApiError
          ? err.message
          : 'Synchro impossible. Réessayez dans un instant.',
      )
    } finally {
      setSyncing(false)
    }
  }, [workspaceId, onRefresh, message])

  return (
    <section
      className="bg-white p-6 rounded-lg shadow-sm space-y-4"
      data-testid="voip-calls-hint"
    >
      <Text type="secondary">
        Vos appels remontent automatiquement comme objectifs
        «&nbsp;phone_call&nbsp;» et apparaissent dans vos vues d'analyse,
        attribués à leur source.
      </Text>

      {/* Déclencheur de synchro manuelle */}
      <div>
        <Button
          type="primary"
          icon={<SyncOutlined spin={syncing} />}
          loading={syncing}
          onClick={runSync}
          data-testid="voip-sync-now-btn"
        >
          Synchroniser maintenant
        </Button>
      </div>

      {/* État de la synchro automatique (cron natif, gated VOIP_SYNC_ENABLED) */}
      <Alert
        type="info"
        showIcon
        data-testid="voip-autosync-hint"
        message="La synchro automatique remonte vos appels toutes les 15 minutes (si elle est activée sur votre instance). En cas de doute juste après une configuration, utilisez « Synchroniser maintenant »."
      />

      <Space size="large" wrap>
        <Typography.Link
          href={`/workspaces/${workspaceId}/live`}
          data-testid="voip-link-live"
        >
          Voir les appels dans En direct →
        </Typography.Link>
        <Typography.Link
          href={`/workspaces/${workspaceId}/explore?filters=event_name%3Dphone_call`}
        >
          Filtrer dans Explorer →
        </Typography.Link>
      </Space>
    </section>
  )
}

// ─── Credential card ─────────────────────────────────────────────────────

function CredentialCard({
  workspaceId,
  cred,
  onChanged,
}: {
  workspaceId: string
  cred: CredentialView
  onChanged: () => void
}) {
  const { message } = App.useApp()
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const runTest = useCallback(async () => {
    setTesting(true)
    try {
      const r = await testCredential(workspaceId, cred.kind)
      if (r.ok) message.success(r.message)
      else message.error(r.message)
      onChanged()
    } catch (err) {
      message.error(
        err instanceof VoipApiError ? err.message : 'Test impossible.',
      )
    } finally {
      setTesting(false)
    }
  }, [workspaceId, cred.kind, onChanged, message])

  const runDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteCredential(workspaceId, cred.kind)
      message.success('Identifiants supprimés')
      onChanged()
    } catch (err) {
      message.error(
        err instanceof VoipApiError ? err.message : 'Suppression impossible.',
      )
      setDeleting(false)
    }
  }, [workspaceId, cred.kind, onChanged, message])

  return (
    <div
      className="rounded-lg border border-gray-200 p-4"
      data-testid={`voip-cred-${cred.kind}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{cred.label}</span>
          <StatusTag status={cred.status} />
        </div>
        <Space>
          <Button
            size="small"
            icon={<ReloadOutlined />}
            loading={testing}
            disabled={deleting}
            onClick={runTest}
            data-testid={`voip-test-${cred.kind}`}
          >
            Tester la connexion
          </Button>
          <Popconfirm
            title="Supprimer les identifiants"
            description="Cette action est irréversible. La synchro des appels sera interrompue."
            onConfirm={runDelete}
            okText="Supprimer"
            cancelText="Annuler"
            okButtonProps={{ danger: true }}
          >
            <Button
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              loading={deleting}
              disabled={testing}
              aria-label="Supprimer"
              data-testid={`voip-delete-${cred.kind}`}
            />
          </Popconfirm>
        </Space>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        {Object.entries(cred.masked).map(([k, v]) => (
          <span key={k}>
            {k}: <span className="tabular-nums">{v}</span>
          </span>
        ))}
      </div>
      {cred.lastSyncAt && (
        <p className="mt-2 text-xs text-gray-400">
          Dernière synchro : {formatDate(cred.lastSyncAt)}
        </p>
      )}
      {cred.lastError && (
        <p className="mt-2 text-xs text-red-500">{cred.lastError}</p>
      )}
    </div>
  )
}

function CredentialForm({
  workspaceId,
  kind,
  fields,
  onSaved,
}: {
  workspaceId: string
  kind: CredentialKind
  fields: Array<{ name: string; label: string; placeholder: string }>
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<Record<string, string>>()
  const [saving, setSaving] = useState(false)

  const submit = useCallback(
    async (values: Record<string, string>) => {
      setSaving(true)
      try {
        await saveCredential(workspaceId, kind, values)
        form.resetFields()
        message.success('Identifiants enregistrés et chiffrés')
        onSaved()
      } catch (err) {
        message.error(
          err instanceof VoipApiError
            ? err.message
            : 'Enregistrement impossible.',
        )
      } finally {
        setSaving(false)
      }
    },
    [workspaceId, kind, onSaved, form, message],
  )

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={submit}
      data-testid="voip-form"
    >
      {fields.map((f) => (
        <Form.Item
          key={f.name}
          name={f.name}
          label={f.label}
          rules={[{ required: true, message: `${f.label} est obligatoire` }]}
        >
          <Input.Password
            autoComplete="off"
            placeholder={f.placeholder}
            data-testid={`voip-field-${f.name}`}
          />
        </Form.Item>
      ))}
      <Button
        type="primary"
        htmlType="submit"
        icon={<CheckCircleOutlined />}
        loading={saving}
        data-testid="voip-save-btn"
      >
        Enregistrer &amp; chiffrer
      </Button>
      <Paragraph type="secondary" className="!mt-3 !mb-0 text-xs">
        {SECRET_NOTICE}
      </Paragraph>
    </Form>
  )
}

// ─── Primitives partagées ────────────────────────────────────────────────

function StatusTag({ status }: { status: string }) {
  if (status === 'ok') return <Tag color="success">Connexion OK</Tag>
  if (status === 'failed') return <Tag color="error">Échec</Tag>
  return <Tag color="default">Non testé</Tag>
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
