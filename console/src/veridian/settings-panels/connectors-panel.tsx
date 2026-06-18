import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Loader2,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
  X,
  XCircle,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../utils';
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
  type WebhookTestResult,
  type DeliveryStatus,
} from './webhooks-api';
import '../theme.css';

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
 * uniquement, jamais de page dédiée.
 *
 * Sécurité — secret Bearer write-only : le token Twenty est chiffré
 * (AES-256-GCM) côté engine et n'est JAMAIS renvoyé. L'API n'expose que
 * `auth.has_secret`. La saisie remplace le secret stocké ; laisser le champ
 * vide à la modification conserve le secret existant.
 */

export interface ConnectorsSettingsPanelProps {
  workspaceId: string;
}

// ─── Libellés FR ──────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  screen_view: 'Page vue (screen_view)',
  goal: 'Objectif atteint (goal)',
  'webhook.test': 'Événement de test',
};

const DELIVERY_STATUS_META: Record<
  DeliveryStatus,
  { label: string; tone: string; variant: 'success' | 'destructive' | 'warning' | 'secondary' }
> = {
  success: { label: 'Réussie', tone: 'text-emerald-500', variant: 'success' },
  pending: { label: 'En attente', tone: 'text-amber-500', variant: 'warning' },
  retrying: { label: 'Nouvelle tentative', tone: 'text-amber-500', variant: 'warning' },
  failed: { label: 'Échec', tone: 'text-destructive', variant: 'destructive' },
  gave_up: { label: 'Abandonnée', tone: 'text-destructive', variant: 'destructive' },
};

/** Statuts pour lesquels un retry manuel a du sens. */
const RETRIABLE: DeliveryStatus[] = ['failed', 'gave_up'];

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; webhooks: PublicWebhook[]; events: WebhookEventType[] };

export function ConnectorsSettingsPanel({
  workspaceId,
}: ConnectorsSettingsPanelProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [creating, setCreating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    Promise.all([
      listWebhooks(workspaceId, { signal: ctrl.signal }),
      listEventTypes(workspaceId, { signal: ctrl.signal }),
    ])
      .then(([webhooks, events]) => {
        if (!ctrl.signal.aborted) setState({ kind: 'ready', webhooks, events });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState({ kind: 'error', error: err });
      });
  }, [workspaceId]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Le catalogue d'événements ne dépend pas du connecteur — on le mémorise pour
  // le passer au formulaire de création même pendant un reload partiel.
  const events =
    state.kind === 'ready' ? state.events : [];

  return (
    <div className="veridian-scope w-full" data-testid="connectors-settings-panel">
      <div className="space-y-6">
        <Section
          icon={Plug}
          title="Connecteurs"
          description="Branchez votre CRM Twenty pour recevoir automatiquement le score de vos visiteurs et leur timeline d'activité. Chaque page vue et objectif atteint est poussé vers votre CRM, en temps réel."
          testId="settings-section-connectors"
        >
          {state.kind === 'loading' && <ListSkeleton />}
          {state.kind === 'error' && (
            <PanelError error={state.error} onRetry={load} />
          )}
          {state.kind === 'ready' && (
            <>
              {state.webhooks.length === 0 ? (
                <EmptyConnectors onAdd={() => setCreating(true)} />
              ) : (
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
              )}

              {state.webhooks.length > 0 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setCreating(true)}
                    data-testid="connectors-add-btn"
                  >
                    <Plus className="h-4 w-4" />
                    Ajouter un connecteur
                  </Button>
                </div>
              )}
            </>
          )}
        </Section>

        {creating && (
          <ConnectorModal
            workspaceId={workspaceId}
            events={events}
            onClose={() => setCreating(false)}
            onSaved={() => {
              setCreating(false);
              load();
            }}
          />
        )}
      </div>
    </div>
  );
}

// ─── Carte d'un connecteur ────────────────────────────────────────────────

function ConnectorCard({
  workspaceId,
  webhook,
  events,
  onChanged,
}: {
  workspaceId: string;
  webhook: PublicWebhook;
  events: WebhookEventType[];
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testResult, setTestResult] = useState<WebhookTestResult | null>(null);
  const [editing, setEditing] = useState(false);
  const [showDeliveries, setShowDeliveries] = useState(false);

  const isTwenty = webhook.transform?.type === 'twenty';
  const dryRun = isTwenty && webhook.transform?.dry_run === true;

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testWebhook(workspaceId, webhook.id);
      setTestResult(r);
    } catch (err) {
      setTestResult({
        delivery_id: '',
        success: false,
        http_status: null,
        latency_ms: null,
        response_body: '',
        error_message:
          err instanceof WebhookApiError ? err.message : 'Test impossible.',
      });
    } finally {
      setTesting(false);
    }
  }, [workspaceId, webhook.id]);

  const toggleActive = useCallback(async () => {
    setTogglingActive(true);
    try {
      await updateWebhook(workspaceId, webhook.id, { active: !webhook.active });
      onChanged();
    } catch {
      setTogglingActive(false);
    }
  }, [workspaceId, webhook.id, webhook.active, onChanged]);

  const runDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteWebhook(workspaceId, webhook.id);
      onChanged();
    } catch {
      setDeleting(false);
    }
  }, [workspaceId, webhook.id, onChanged]);

  const busy = testing || togglingActive || deleting;

  return (
    <div
      className="rounded-lg border border-border/50 bg-background/30 p-4"
      data-testid={`connector-card-${webhook.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{webhook.name}</span>
            {isTwenty ? (
              <Badge variant="secondary">Twenty CRM</Badge>
            ) : (
              <Badge variant="outline">Webhook</Badge>
            )}
            <ActiveBadge active={webhook.active} />
            {dryRun && <Badge variant="warning">Simulation</Badge>}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {webhook.url}
          </p>
          <div className="flex flex-wrap gap-1 pt-0.5">
            {webhook.events.map((ev) => (
              <span
                key={ev}
                className="inline-flex rounded-full border border-border/50 bg-background/40 px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {EVENT_LABELS[ev] ?? ev}
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={runTest}
          disabled={busy}
          data-testid={`connector-test-${webhook.id}`}
        >
          {testing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Tester
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowDeliveries((s) => !s)}
          disabled={deleting}
          data-testid={`connector-deliveries-toggle-${webhook.id}`}
        >
          <History className="h-3.5 w-3.5" />
          Livraisons
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setEditing(true)}
          disabled={busy}
          data-testid={`connector-edit-${webhook.id}`}
        >
          Modifier
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={toggleActive}
          disabled={busy}
          data-testid={`connector-toggle-active-${webhook.id}`}
        >
          {togglingActive && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {webhook.active ? 'Désactiver' : 'Activer'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={runDelete}
          disabled={busy}
          aria-label="Supprimer"
          data-testid={`connector-delete-${webhook.id}`}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>

      {testResult && <TestResultRow result={testResult} />}

      {showDeliveries && (
        <DeliveriesSection
          workspaceId={workspaceId}
          webhookId={webhook.id}
        />
      )}

      {editing && (
        <ConnectorModal
          workspaceId={workspaceId}
          events={events}
          existing={webhook}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function TestResultRow({ result }: { result: WebhookTestResult }) {
  return (
    <div
      className={cn(
        'mt-3 flex items-start gap-2 rounded-md border p-2.5 text-xs',
        result.success
          ? 'border-emerald-400/30 bg-emerald-400/5 text-emerald-500'
          : 'border-destructive/30 bg-destructive/5 text-destructive',
      )}
      data-testid="connector-test-result"
    >
      {result.success ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      )}
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">
          {result.success
            ? 'Connexion réussie'
            : 'La livraison de test a échoué'}
          {result.http_status != null && (
            <span className="ml-1 font-normal tabular-nums">
              (HTTP {result.http_status}
              {result.latency_ms != null ? `, ${result.latency_ms} ms` : ''})
            </span>
          )}
        </p>
        {result.error_message && (
          <p className="break-words text-muted-foreground">
            {result.error_message}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Livraisons récentes + retry ──────────────────────────────────────────

function DeliveriesSection({
  workspaceId,
  webhookId,
}: {
  workspaceId: string;
  webhookId: string;
}) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; error: Error }
    | { kind: 'ready'; rows: WebhookDelivery[] }
  >({ kind: 'loading' });
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    listDeliveries(workspaceId, { webhookId, limit: 20 })
      .then((rows) => setState({ kind: 'ready', rows }))
      .catch((err: Error) => setState({ kind: 'error', error: err }));
  }, [workspaceId, webhookId]);

  useEffect(() => {
    load();
  }, [load]);

  const onRetry = useCallback(
    async (deliveryId: string) => {
      setRetryingId(deliveryId);
      try {
        await retryDelivery(workspaceId, deliveryId);
        load();
      } catch {
        /* fail-soft : la livraison garde son statut, l'erreur ressort au reload */
      } finally {
        setRetryingId(null);
      }
    },
    [workspaceId, load],
  );

  return (
    <div
      className="mt-3 rounded-lg border border-border/40 bg-background/20 p-3"
      data-testid={`connector-deliveries-${webhookId}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
          Livraisons récentes
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={load}
          aria-label="Rafraîchir"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      {state.kind === 'loading' && (
        <div className="h-16 animate-pulse rounded-md border border-border/40 bg-card/30" />
      )}
      {state.kind === 'error' && (
        <p className="text-xs text-destructive">{state.error.message}</p>
      )}
      {state.kind === 'ready' &&
        (state.rows.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted-foreground">
            Aucune livraison pour le moment.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border/40">
            <table className="w-full text-xs">
              <thead className="bg-background/40 text-[10px] uppercase tracking-wider text-muted-foreground/70">
                <tr>
                  <th className="px-3 py-1.5 text-left">Événement</th>
                  <th className="px-3 py-1.5 text-left">Statut</th>
                  <th className="px-3 py-1.5 text-left">Quand</th>
                  <th className="px-3 py-1.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {state.rows.map((d) => {
                  const meta =
                    DELIVERY_STATUS_META[d.status] ??
                    DELIVERY_STATUS_META.pending;
                  const canRetry = RETRIABLE.includes(d.status);
                  return (
                    <tr
                      key={d.id}
                      className="border-t border-border/30"
                      data-testid={`delivery-row-${d.id}`}
                    >
                      <td className="px-3 py-1.5">
                        <span className="text-muted-foreground">
                          {EVENT_LABELS[d.event_type] ?? d.event_type}
                        </span>
                        {d.http_status != null && (
                          <span className="ml-1 tabular-nums text-muted-foreground/60">
                            · {d.http_status}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums text-muted-foreground/70">
                        {formatDate(d.sent_at ?? d.scheduled_at)}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {canRetry && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => onRetry(d.id)}
                            disabled={retryingId === d.id}
                            data-testid={`delivery-retry-${d.id}`}
                          >
                            {retryingId === d.id ? (
                              <Loader2 className="h-3 w-3 animate-spin" />
                            ) : (
                              <RefreshCw className="h-3 w-3" />
                            )}
                            Retenter
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ))}
    </div>
  );
}

// ─── Modale création / modification ───────────────────────────────────────

function ConnectorModal({
  workspaceId,
  events,
  existing,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  events: WebhookEventType[];
  existing?: PublicWebhook;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [token, setToken] = useState('');
  const [dryRun, setDryRun] = useState(
    existing?.transform?.type === 'twenty'
      ? existing.transform.dry_run === true
      : false,
  );
  const [selectedEvents, setSelectedEvents] = useState<string[]>(
    existing?.events ?? ['screen_view', 'goal'],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // En création, on n'expose que les événements pertinents pour Twenty
  // (screen_view / goal). L'événement interne `webhook.test` est filtré.
  const selectableEvents = useMemo(
    () => events.filter((e) => e.type !== 'webhook.test'),
    [events],
  );

  const hasSecret = existing?.auth.has_secret === true;

  const toggleEvent = (type: string) => {
    setSelectedEvents((prev) =>
      prev.includes(type)
        ? prev.filter((t) => t !== type)
        : [...prev, type],
    );
  };

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        if (isEdit && existing) {
          await updateWebhook(workspaceId, existing.id, {
            name: name.trim(),
            url: url.trim(),
            events: selectedEvents,
            transform: { type: 'twenty', dry_run: dryRun },
            // Le secret n'est envoyé QUE si l'utilisateur en saisit un nouveau ;
            // un champ vide conserve le Bearer chiffré déjà stocké.
            ...(token.trim()
              ? { auth: { type: 'bearer' as const, token: token.trim() } }
              : {}),
          });
        } else {
          await createWebhook(workspaceId, {
            name: name.trim(),
            url: url.trim(),
            active: true,
            auth: { type: 'bearer', token: token.trim() },
            events: selectedEvents,
            transform: { type: 'twenty', dry_run: dryRun },
          });
        }
        onSaved();
      } catch (err) {
        if (err instanceof WebhookApiError) {
          if (err.code === 'DUPLICATE_NAME') {
            setError('Un connecteur portant ce nom existe déjà.');
          } else {
            setError(err.message);
          }
        } else {
          setError('Enregistrement impossible.');
        }
      } finally {
        setSaving(false);
      }
    },
    [
      isEdit,
      existing,
      workspaceId,
      name,
      url,
      token,
      selectedEvents,
      dryRun,
      onSaved,
    ],
  );

  // Création : nom + url + secret + au moins 1 événement.
  // Modification : le secret reste optionnel (vide = inchangé).
  const canSubmit =
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    selectedEvents.length > 0 &&
    (isEdit || token.trim().length > 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="connector-modal"
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-lg border-border/70 bg-card shadow-xl">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-lg font-semibold">
                {isEdit
                  ? 'Modifier le connecteur Twenty'
                  : 'Connecter votre CRM Twenty'}
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Renseignez l'URL REST de votre Twenty et votre clé API. Le score
                et la timeline de vos visiteurs y seront poussés automatiquement.
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="Fermer"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <form onSubmit={submit} className="space-y-4">
            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
                Nom du connecteur
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Mon CRM Twenty"
                maxLength={120}
                className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm"
                data-testid="connector-field-name"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
                URL REST Twenty
              </label>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://crm.exemple.fr/rest"
                className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm"
                data-testid="connector-field-url"
                required
              />
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
                Clé API (Bearer Twenty)
              </label>
              <input
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={
                  hasSecret
                    ? 'Laisser vide pour conserver la clé actuelle'
                    : 'eyJhbGci…'
                }
                className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm"
                data-testid="connector-field-token"
              />
              <p className="mt-1 text-[11px] text-muted-foreground/70">
                {hasSecret
                  ? 'Une clé est déjà enregistrée (chiffrée). Saisissez-en une nouvelle uniquement pour la remplacer.'
                  : 'Votre clé est chiffrée (AES-256-GCM) avant stockage et n\'est jamais réaffichée en clair.'}
              </p>
            </div>

            <div>
              <span className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
                Événements poussés
              </span>
              <div className="mt-2 space-y-2">
                {selectableEvents.map((ev) => (
                  <label
                    key={ev.type}
                    className="flex cursor-pointer items-start gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={selectedEvents.includes(ev.type)}
                      onChange={() => toggleEvent(ev.type)}
                      className="mt-0.5"
                      data-testid={`connector-event-${ev.type}`}
                    />
                    <span>
                      <span className="font-medium">
                        {EVENT_LABELS[ev.type] ?? ev.type}
                      </span>
                      <span className="block text-[11px] text-muted-foreground/70">
                        {ev.description}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border/50 bg-background/20 p-3 text-sm">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="mt-0.5"
                data-testid="connector-field-dryrun"
              />
              <span>
                <span className="font-medium">Mode simulation (dry-run)</span>
                <span className="block text-[11px] text-muted-foreground/70">
                  Les écritures dans Twenty sont journalisées mais pas envoyées.
                  Utile pour valider la connexion sans modifier votre CRM.
                </span>
              </span>
            </label>

            {error && <InlineError message={error} />}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onClose}
                disabled={saving}
              >
                Annuler
              </Button>
              <Button
                type="submit"
                size="sm"
                disabled={saving || !canSubmit}
                data-testid="connector-save-btn"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {isEdit ? 'Enregistrer' : 'Connecter'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────

function EmptyConnectors({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="rounded-lg border border-dashed border-border/60 bg-background/20 p-6 text-center"
      data-testid="connectors-empty"
    >
      <p className="text-sm text-muted-foreground">
        Aucun connecteur pour le moment. Branchez votre CRM Twenty pour y
        recevoir automatiquement le score et la timeline de vos visiteurs.
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={onAdd}
        data-testid="connectors-empty-add"
      >
        <Plus className="h-4 w-4" />
        Connecter votre CRM Twenty
      </Button>
    </div>
  );
}

// ─── Primitives partagées ─────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  description,
  children,
  testId,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <Card
      className="veridian-fade-in-delay-1 border-border/60 bg-card/80"
      data-testid={testId}
    >
      <CardContent className="space-y-5 p-6 sm:p-7">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Icon className="h-5 w-5" />
          </div>
          <div className="space-y-0.5">
            <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
            {description && (
              <p className="text-sm text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
        <div className="space-y-4">{children}</div>
      </CardContent>
    </Card>
  );
}

function ActiveBadge({ active }: { active: boolean }) {
  return active ? (
    <Badge variant="success">Actif</Badge>
  ) : (
    <Badge variant="warning">Inactif</Badge>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <p
      className="flex items-center gap-1.5 text-xs text-destructive"
      data-testid="settings-inline-error"
    >
      <AlertTriangle className="h-3.5 w-3.5" />
      {message}
    </p>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-3" data-testid="connectors-skeleton">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-24 animate-pulse rounded-lg border border-border/50 bg-card/40"
        />
      ))}
    </div>
  );
}

function PanelError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardContent
        className="flex flex-col items-start gap-3 p-6"
        data-testid="connectors-panel-error"
      >
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span className="font-medium">
            Impossible de charger les connecteurs
          </span>
        </div>
        <p className="text-sm text-muted-foreground">{error.message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" />
          Réessayer
        </Button>
      </CardContent>
    </Card>
  );
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
