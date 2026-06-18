import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plug } from 'lucide-react'
import {
  App,
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Table,
  Tag,
  Typography,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import {
  DeleteOutlined,
  HistoryOutlined,
  PlusOutlined,
  ReloadOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import {
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  listDeliveries,
  retryDelivery,
  listEventTypes,
  WebhookApiError,
  type PublicWebhook,
  type WebhookDelivery,
  type WebhookEventType,
  type DeliveryStatus,
} from './webhooks-api'

const { Title, Text, Paragraph } = Typography

/**
 * ConnectorsSettingsPanel — onglet « Connecteurs » dans Settings native.
 *
 * Onglet dédié dans la sidebar Settings staminads (z.enum `'connectors'`).
 * Self-config des connecteurs depuis la console (ticket 2026-06-17) : pilote
 * le module `webhooks` natif de l'engine — créer un connecteur Twenty, le
 * tester, voir les livraisons, retenter les échecs, activer / désactiver /
 * supprimer. Avant ce panel, brancher un Twenty exigeait l'API M2M en CLI.
 *
 * Conforme à la vision Robert 2026-05-23 : extension Veridian = onglet Settings
 * uniquement, jamais de page dédiée. Présentation 100 % Ant Design natif
 * (fond clair, primaire violet) — alignée sur api-keys / TeamSettings.
 *
 * Sécurité — secret Bearer write-only : le token Twenty est chiffré
 * (AES-256-GCM) côté engine et n'est JAMAIS renvoyé. L'API n'expose que
 * `auth.has_secret`. La saisie remplace le secret stocké ; laisser le champ
 * vide à la modification conserve le secret existant.
 */

export interface ConnectorsSettingsPanelProps {
  workspaceId: string
}

// ─── Libellés FR ──────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  screen_view: 'Page vue (screen_view)',
  goal: 'Objectif atteint (goal)',
  'webhook.test': 'Événement de test',
}

const DELIVERY_STATUS_META: Record<
  DeliveryStatus,
  { label: string; color: string }
> = {
  success: { label: 'Réussie', color: 'success' },
  pending: { label: 'En attente', color: 'warning' },
  retrying: { label: 'Nouvelle tentative', color: 'warning' },
  failed: { label: 'Échec', color: 'error' },
  gave_up: { label: 'Abandonnée', color: 'error' },
}

/** Statuts pour lesquels un retry manuel a du sens. */
const RETRIABLE: DeliveryStatus[] = ['failed', 'gave_up']

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; webhooks: PublicWebhook[]; events: WebhookEventType[] }

export function ConnectorsSettingsPanel({
  workspaceId,
}: ConnectorsSettingsPanelProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' })
  const [creating, setCreating] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setState({ kind: 'loading' })
    Promise.all([
      listWebhooks(workspaceId, { signal: ctrl.signal }),
      listEventTypes(workspaceId, { signal: ctrl.signal }),
    ])
      .then(([webhooks, events]) => {
        if (!ctrl.signal.aborted) setState({ kind: 'ready', webhooks, events })
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

  // Le catalogue d'événements ne dépend pas du connecteur — on le mémorise pour
  // le passer au formulaire de création même pendant un reload partiel.
  const events = state.kind === 'ready' ? state.events : []

  return (
    <div className="max-w-3xl" data-testid="connectors-settings-panel">
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <Plug size={20} className="text-[var(--primary)]" />
          <Title level={4} className="!mb-0">
            Connecteurs
          </Title>
        </div>
        <Paragraph type="secondary" className="!mt-2 !mb-0">
          Branchez votre CRM Twenty pour recevoir automatiquement le score de vos
          visiteurs et leur timeline d'activité. Chaque page vue et objectif
          atteint est poussé vers votre CRM, en temps réel.
        </Paragraph>
      </div>

      {state.kind === 'loading' && <ListSkeleton />}
      {state.kind === 'error' && (
        <PanelError error={state.error} onRetry={load} />
      )}
      {state.kind === 'ready' && (
        <>
          {state.webhooks.length === 0 ? (
            <EmptyConnectors onAdd={() => setCreating(true)} />
          ) : (
            <>
              <div className="space-y-3" data-testid="connectors-list">
                {state.webhooks.map((wh) => (
                  <ConnectorCard
                    key={wh.id}
                    workspaceId={workspaceId}
                    webhook={wh}
                    events={events}
                    onChanged={load}
                  />
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  onClick={() => setCreating(true)}
                  data-testid="connectors-add-btn"
                >
                  Ajouter un connecteur
                </Button>
              </div>
            </>
          )}
        </>
      )}

      {creating && (
        <ConnectorModal
          workspaceId={workspaceId}
          events={events}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false)
            load()
          }}
        />
      )}
    </div>
  )
}

// ─── Carte d'un connecteur ────────────────────────────────────────────────

function ConnectorCard({
  workspaceId,
  webhook,
  events,
  onChanged,
}: {
  workspaceId: string
  webhook: PublicWebhook
  events: WebhookEventType[]
  onChanged: () => void
}) {
  const { message } = App.useApp()
  const [testing, setTesting] = useState(false)
  const [togglingActive, setTogglingActive] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showDeliveries, setShowDeliveries] = useState(false)

  const isTwenty = webhook.transform?.type === 'twenty'
  const dryRun = isTwenty && webhook.transform?.dry_run === true

  const runTest = useCallback(async () => {
    setTesting(true)
    try {
      const r = await testWebhook(workspaceId, webhook.id)
      if (r.success) {
        const detail =
          r.http_status != null
            ? ` (HTTP ${r.http_status}${
                r.latency_ms != null ? `, ${r.latency_ms} ms` : ''
              })`
            : ''
        message.success(`Connexion réussie${detail}`)
      } else {
        const detail =
          r.http_status != null
            ? ` (HTTP ${r.http_status}${
                r.latency_ms != null ? `, ${r.latency_ms} ms` : ''
              })`
            : ''
        message.error(
          `La livraison de test a échoué${detail}${
            r.error_message ? ` — ${r.error_message}` : ''
          }`,
        )
      }
    } catch (err) {
      message.error(
        err instanceof WebhookApiError ? err.message : 'Test impossible.',
      )
    } finally {
      setTesting(false)
    }
  }, [workspaceId, webhook.id, message])

  const toggleActive = useCallback(async () => {
    setTogglingActive(true)
    try {
      await updateWebhook(workspaceId, webhook.id, { active: !webhook.active })
      message.success(webhook.active ? 'Connecteur désactivé' : 'Connecteur activé')
      onChanged()
    } catch (err) {
      message.error(
        err instanceof WebhookApiError ? err.message : 'Mise à jour impossible.',
      )
      setTogglingActive(false)
    }
  }, [workspaceId, webhook.id, webhook.active, onChanged, message])

  const runDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteWebhook(workspaceId, webhook.id)
      message.success('Connecteur supprimé')
      onChanged()
    } catch (err) {
      message.error(
        err instanceof WebhookApiError ? err.message : 'Suppression impossible.',
      )
      setDeleting(false)
    }
  }, [workspaceId, webhook.id, onChanged, message])

  const busy = testing || togglingActive || deleting

  return (
    <div
      className="bg-white rounded-lg border border-gray-200 p-4"
      data-testid={`connector-card-${webhook.id}`}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{webhook.name}</span>
          {isTwenty ? (
            <Tag color="purple">Twenty CRM</Tag>
          ) : (
            <Tag>Webhook</Tag>
          )}
          <Tag color={webhook.active ? 'success' : 'warning'}>
            {webhook.active ? 'Actif' : 'Inactif'}
          </Tag>
          {dryRun && <Tag color="warning">Simulation</Tag>}
        </div>
        <Text type="secondary" className="block truncate font-mono text-xs">
          {webhook.url}
        </Text>
        <div className="flex flex-wrap gap-1 pt-0.5">
          {webhook.events.map((ev) => (
            <Tag key={ev} className="!mr-0">
              {EVENT_LABELS[ev] ?? ev}
            </Tag>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          size="small"
          icon={<SyncOutlined spin={testing} />}
          onClick={runTest}
          disabled={busy}
          data-testid={`connector-test-${webhook.id}`}
        >
          Tester la connexion
        </Button>
        <Button
          type="text"
          size="small"
          icon={<HistoryOutlined />}
          onClick={() => setShowDeliveries((s) => !s)}
          disabled={deleting}
          data-testid={`connector-deliveries-toggle-${webhook.id}`}
        >
          Livraisons
        </Button>
        <Button
          type="text"
          size="small"
          onClick={() => setEditing(true)}
          disabled={busy}
          data-testid={`connector-edit-${webhook.id}`}
        >
          Modifier
        </Button>
        <Button
          type="text"
          size="small"
          loading={togglingActive}
          onClick={toggleActive}
          disabled={busy}
          data-testid={`connector-toggle-active-${webhook.id}`}
        >
          {webhook.active ? 'Désactiver' : 'Activer'}
        </Button>
        <Popconfirm
          title="Supprimer le connecteur"
          description="Êtes-vous sûr de vouloir supprimer ce connecteur ? Cette action est irréversible."
          onConfirm={runDelete}
          okText="Supprimer"
          cancelText="Annuler"
          okButtonProps={{ danger: true }}
        >
          <Button
            type="text"
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={deleting}
            disabled={testing || togglingActive}
            aria-label="Supprimer"
            data-testid={`connector-delete-${webhook.id}`}
          />
        </Popconfirm>
      </div>

      {showDeliveries && (
        <DeliveriesSection workspaceId={workspaceId} webhookId={webhook.id} />
      )}

      {editing && (
        <ConnectorModal
          workspaceId={workspaceId}
          events={events}
          existing={webhook}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false)
            onChanged()
          }}
        />
      )}
    </div>
  )
}

// ─── Livraisons récentes + retry ──────────────────────────────────────────

function DeliveriesSection({
  workspaceId,
  webhookId,
}: {
  workspaceId: string
  webhookId: string
}) {
  const { message } = App.useApp()
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; error: Error }
    | { kind: 'ready'; rows: WebhookDelivery[] }
  >({ kind: 'loading' })
  const [retryingId, setRetryingId] = useState<string | null>(null)

  const load = useCallback(() => {
    setState({ kind: 'loading' })
    listDeliveries(workspaceId, { webhookId, limit: 20 })
      .then((rows) => setState({ kind: 'ready', rows }))
      .catch((err: Error) => setState({ kind: 'error', error: err }))
  }, [workspaceId, webhookId])

  useEffect(() => {
    load()
  }, [load])

  const onRetry = useCallback(
    async (deliveryId: string) => {
      setRetryingId(deliveryId)
      try {
        await retryDelivery(workspaceId, deliveryId)
        message.success('Nouvelle tentative programmée')
        load()
      } catch {
        // fail-soft : la livraison garde son statut, l'erreur ressort au reload
        message.error('Nouvelle tentative impossible.')
      } finally {
        setRetryingId(null)
      }
    },
    [workspaceId, load, message],
  )

  const columns: ColumnsType<WebhookDelivery> = [
    {
      title: 'Événement',
      key: 'event',
      render: (_, d) => (
        <span className="text-xs">
          <span>{EVENT_LABELS[d.event_type] ?? d.event_type}</span>
          {d.http_status != null && (
            <Text type="secondary" className="ml-1 tabular-nums">
              · {d.http_status}
            </Text>
          )}
        </span>
      ),
    },
    {
      title: 'Statut',
      key: 'status',
      width: 130,
      render: (_, d) => {
        const meta = DELIVERY_STATUS_META[d.status] ?? DELIVERY_STATUS_META.pending
        return <Tag color={meta.color}>{meta.label}</Tag>
      },
    },
    {
      title: 'Quand',
      key: 'when',
      width: 130,
      render: (_, d) => (
        <Text type="secondary" className="text-xs tabular-nums">
          {formatDate(d.sent_at ?? d.scheduled_at)}
        </Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 110,
      align: 'right',
      render: (_, d) =>
        RETRIABLE.includes(d.status) ? (
          <Button
            size="small"
            icon={<ReloadOutlined spin={retryingId === d.id} />}
            onClick={() => onRetry(d.id)}
            disabled={retryingId === d.id}
            data-testid={`delivery-retry-${d.id}`}
          >
            Retenter
          </Button>
        ) : null,
    },
  ]

  return (
    <div
      className="mt-3 rounded-lg border border-gray-100 bg-gray-50 p-3"
      data-testid={`connector-deliveries-${webhookId}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <Text type="secondary" className="text-xs uppercase tracking-wider">
          Livraisons récentes
        </Text>
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined />}
          onClick={load}
          aria-label="Rafraîchir"
        />
      </div>

      {state.kind === 'error' && (
        <Alert
          type="error"
          showIcon
          message={state.error.message}
          className="!py-1.5"
        />
      )}
      {(state.kind === 'loading' || state.kind === 'ready') && (
        <Table
          dataSource={state.kind === 'ready' ? state.rows : []}
          columns={columns}
          rowKey="id"
          size="small"
          loading={state.kind === 'loading'}
          pagination={false}
          locale={{ emptyText: 'Aucune livraison pour le moment.' }}
          onRow={(d) => ({ 'data-testid': `delivery-row-${d.id}` }) as object}
        />
      )}
    </div>
  )
}

// ─── Modale création / modification ───────────────────────────────────────

interface ConnectorFormValues {
  name: string
  url: string
  token?: string
  events: string[]
  dryRun: boolean
}

function ConnectorModal({
  workspaceId,
  events,
  existing,
  onClose,
  onSaved,
}: {
  workspaceId: string
  events: WebhookEventType[]
  existing?: PublicWebhook
  onClose: () => void
  onSaved: () => void
}) {
  const { message } = App.useApp()
  const [form] = Form.useForm<ConnectorFormValues>()
  const [saving, setSaving] = useState(false)

  const isEdit = !!existing
  const hasSecret = existing?.auth.has_secret === true

  // En création, on n'expose que les événements pertinents pour Twenty
  // (screen_view / goal). L'événement interne `webhook.test` est filtré.
  const eventOptions = useMemo(
    () =>
      events
        .filter((e) => e.type !== 'webhook.test')
        .map((ev) => ({
          value: ev.type,
          label: (
            <span>
              <span className="font-medium">
                {EVENT_LABELS[ev.type] ?? ev.type}
              </span>
              <span className="block text-xs text-gray-500">
                {ev.description}
              </span>
            </span>
          ),
        })),
    [events],
  )

  const submit = useCallback(
    async (values: ConnectorFormValues) => {
      const token = values.token?.trim() ?? ''
      setSaving(true)
      try {
        if (isEdit && existing) {
          await updateWebhook(workspaceId, existing.id, {
            name: values.name.trim(),
            url: values.url.trim(),
            events: values.events,
            transform: { type: 'twenty', dry_run: values.dryRun },
            // Le secret n'est envoyé QUE si l'utilisateur en saisit un nouveau ;
            // un champ vide conserve le Bearer chiffré déjà stocké.
            ...(token
              ? { auth: { type: 'bearer' as const, token } }
              : {}),
          })
        } else {
          await createWebhook(workspaceId, {
            name: values.name.trim(),
            url: values.url.trim(),
            active: true,
            auth: { type: 'bearer', token },
            events: values.events,
            transform: { type: 'twenty', dry_run: values.dryRun },
          })
        }
        message.success(isEdit ? 'Connecteur enregistré' : 'Connecteur créé')
        onSaved()
      } catch (err) {
        if (err instanceof WebhookApiError) {
          message.error(
            err.code === 'DUPLICATE_NAME'
              ? 'Un connecteur portant ce nom existe déjà.'
              : err.message,
          )
        } else {
          message.error('Enregistrement impossible.')
        }
        setSaving(false)
      }
    },
    [isEdit, existing, workspaceId, onSaved, message],
  )

  return (
    <Modal
      title={isEdit ? 'Modifier le connecteur Twenty' : 'Connecter votre CRM Twenty'}
      open
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={saving}
      okText={isEdit ? 'Enregistrer' : 'Connecter'}
      cancelText="Annuler"
      width={560}
      data-testid="connector-modal"
    >
      <Paragraph type="secondary" className="!mt-1">
        Renseignez l'URL REST de votre Twenty et votre clé API. Le score et la
        timeline de vos visiteurs y seront poussés automatiquement.
      </Paragraph>

      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        requiredMark={false}
        initialValues={{
          name: existing?.name ?? '',
          url: existing?.url ?? '',
          token: '',
          events: existing?.events ?? ['screen_view', 'goal'],
          dryRun:
            existing?.transform?.type === 'twenty'
              ? existing.transform.dry_run === true
              : false,
        }}
      >
        <Form.Item
          name="name"
          label="Nom du connecteur"
          rules={[
            { required: true, message: 'Le nom est obligatoire' },
            { max: 120, message: 'Le nom doit faire 120 caractères maximum' },
          ]}
        >
          <Input
            placeholder="Mon CRM Twenty"
            maxLength={120}
            data-testid="connector-field-name"
          />
        </Form.Item>

        <Form.Item
          name="url"
          label="URL REST Twenty"
          rules={[
            { required: true, message: "L'URL est obligatoire" },
            { type: 'url', message: 'Saisissez une URL valide' },
          ]}
        >
          <Input
            type="url"
            placeholder="https://crm.exemple.fr/rest"
            className="font-mono"
            data-testid="connector-field-url"
          />
        </Form.Item>

        <Form.Item
          name="token"
          label="Clé API (Bearer Twenty)"
          rules={
            isEdit
              ? []
              : [{ required: true, message: 'La clé API est obligatoire' }]
          }
          extra={
            hasSecret
              ? 'Une clé est déjà enregistrée (chiffrée). Saisissez-en une nouvelle uniquement pour la remplacer.'
              : "Votre clé est chiffrée (AES-256-GCM) avant stockage et n'est jamais réaffichée en clair."
          }
        >
          <Input.Password
            autoComplete="off"
            placeholder={
              hasSecret ? 'Laisser vide pour conserver la clé actuelle' : 'eyJhbGci…'
            }
            className="font-mono"
            data-testid="connector-field-token"
          />
        </Form.Item>

        <Form.Item
          name="events"
          label="Événements poussés"
          rules={[{ required: true, message: 'Sélectionnez au moins un événement' }]}
        >
          <Checkbox.Group className="flex flex-col gap-2">
            {eventOptions.map((opt) => (
              <Checkbox
                key={opt.value}
                value={opt.value}
                data-testid={`connector-event-${opt.value}`}
              >
                {opt.label}
              </Checkbox>
            ))}
          </Checkbox.Group>
        </Form.Item>

        <Form.Item
          name="dryRun"
          valuePropName="checked"
          className="!mb-0 rounded-md border border-gray-200 bg-gray-50 p-3"
        >
          <Checkbox data-testid="connector-field-dryrun">
            <span className="font-medium">Mode simulation (dry-run)</span>
            <span className="block text-xs text-gray-500">
              Les écritures dans Twenty sont journalisées mais pas envoyées.
              Utile pour valider la connexion sans modifier votre CRM.
            </span>
          </Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyConnectors({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="bg-white rounded-lg border border-gray-200 p-8"
      data-testid="connectors-empty"
    >
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <Text type="secondary">
            Aucun connecteur pour le moment. Branchez votre CRM Twenty pour y
            recevoir automatiquement le score et la timeline de vos visiteurs.
          </Text>
        }
      >
        <Button
          type="primary"
          icon={<PlusOutlined />}
          onClick={onAdd}
          data-testid="connectors-empty-add"
        >
          Connecter votre CRM Twenty
        </Button>
      </Empty>
    </div>
  )
}

// ─── États de chargement / erreur ─────────────────────────────────────────

function ListSkeleton() {
  return (
    <div className="space-y-3" data-testid="connectors-skeleton">
      {[0, 1].map((i) => (
        <Card key={i} loading size="small" />
      ))}
    </div>
  )
}

function PanelError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message="Impossible de charger les connecteurs"
      description={error.message}
      data-testid="connectors-panel-error"
      action={
        <Button size="small" icon={<ReloadOutlined />} onClick={onRetry}>
          Réessayer
        </Button>
      }
    />
  )
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}
