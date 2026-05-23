import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Loader2,
  Phone,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../utils';
import {
  fetchTenantSettings,
  saveCredential,
  testCredential,
  deleteCredential,
  fetchCalls,
  BridgeApiError,
  type TenantSettingsResponse,
  type CredentialKind,
  type CredentialView,
  type CallsResponse,
} from '../api';
import '../theme.css';

/**
 * VoIPSettingsPanel — onglet « Téléphonie / VoIP » dans Settings native.
 *
 * Onglet dédié dans la sidebar Settings staminads (z.enum `'voip'`). C'est la
 * SEULE entrée d'accès à la gestion de la téléphonie : il n'y a pas de page
 * `/calls` dédiée, les appels remontent comme événements `phone_call` dans
 * les vues natives staminads (Live, Explore, Goals).
 *
 * Sections :
 *   1. Choix opérateur (OVH / Telnyx) + formulaire credentials chiffrés (AES-256-GCM)
 *   2. Liste des credentials enregistrés (masqués) + bouton Tester / Supprimer
 *   3. Mini-récap : X appels syncés sur 30j + lien « Voir les appels dans Live »
 *
 * Sécurité : la page n'affiche JAMAIS les credentials en clair — l'API ne
 * renvoie que des valeurs masquées (`••••1234`). La saisie d'un nouveau
 * credential remplace l'ancien (les champs sont vidés après envoi).
 */

export interface VoIPSettingsPanelProps {
  workspaceId: string;
}

const VOIP_PROVIDERS: Array<{
  kind: CredentialKind;
  label: string;
  fields: Array<{ name: string; label: string; placeholder: string }>;
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
    fields: [
      { name: 'apiKey', label: 'API Key', placeholder: 'KEY...' },
    ],
  },
];

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: TenantSettingsResponse };

export function VoIPSettingsPanel({ workspaceId }: VoIPSettingsPanelProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    fetchTenantSettings(workspaceId, { signal: ctrl.signal })
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ kind: 'ready', data });
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

  return (
    <div
      className="veridian-scope w-full"
      data-testid="voip-settings-panel"
    >
      <div className="space-y-6">
        {state.kind === 'loading' && <PanelSkeleton />}
        {state.kind === 'error' && (
          <PanelError error={state.error} onRetry={load} />
        )}
        {state.kind === 'ready' && (
          <VoipContent
            workspaceId={workspaceId}
            credentials={state.data.credentials}
            onRefresh={load}
          />
        )}
      </div>
    </div>
  );
}

function VoipContent({
  workspaceId,
  credentials,
  onRefresh,
}: {
  workspaceId: string;
  credentials: CredentialView[];
  onRefresh: () => void;
}) {
  const [provider, setProvider] = useState<CredentialKind>('voip_ovh');
  const def = useMemo(
    () => VOIP_PROVIDERS.find((p) => p.kind === provider)!,
    [provider],
  );

  const hasConnectedCred = credentials.some((c) => c.status === 'ok');

  return (
    <>
      <Section
        icon={Phone}
        title="Téléphonie / VoIP"
        description="Branchez votre opérateur pour remonter vos appels dans Veridian. Les appels apparaîtront dans la vue En direct et dans Explorer."
        testId="settings-section-voip"
      >
        {/* Credentials déjà enregistrés */}
        {credentials.length > 0 && (
          <div className="space-y-3" data-testid="voip-credentials-list">
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
        <div className="rounded-lg border border-dashed border-border/60 bg-background/20 p-4">
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
            Opérateur
          </label>
          <select
            value={provider}
            onChange={(e) => setProvider(e.target.value as CredentialKind)}
            className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm"
            data-testid="voip-provider-select"
          >
            {VOIP_PROVIDERS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label}
              </option>
            ))}
          </select>
          <CredentialForm
            key={provider}
            workspaceId={workspaceId}
            kind={def.kind}
            fields={def.fields}
            onSaved={onRefresh}
          />
        </div>
      </Section>

      {/* Mini-récap appels — visible seulement si au moins un cred OK */}
      {hasConnectedCred && (
        <CallsRecap workspaceId={workspaceId} />
      )}
    </>
  );
}

// ─── Mini-récap appels syncés ─────────────────────────────────────────────

function CallsRecap({ workspaceId }: { workspaceId: string }) {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; data: CallsResponse }
    | { kind: 'not-connected' }
    | { kind: 'error' }
  >({ kind: 'loading' });

  useEffect(() => {
    const ctrl = new AbortController();
    fetchCalls(workspaceId, 30, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        if (!data.voipConnected) {
          setState({ kind: 'not-connected' });
        } else {
          setState({ kind: 'ready', data });
        }
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof BridgeApiError && err.status === 404) {
          setState({ kind: 'not-connected' });
          return;
        }
        setState({ kind: 'error' });
      });
    return () => ctrl.abort();
  }, [workspaceId]);

  if (state.kind === 'loading') {
    return (
      <Card className="border-border/60 bg-card/60">
        <CardContent className="p-5">
          <div className="veridian-skeleton h-5 w-40 rounded" />
          <div className="veridian-skeleton mt-3 h-8 w-24 rounded" />
        </CardContent>
      </Card>
    );
  }

  if (state.kind === 'error' || state.kind === 'not-connected') {
    return null;
  }

  const { data } = state;
  return (
    <Card
      className="veridian-fade-in-delay-2 border-border/60 bg-card/60"
      data-testid="voip-calls-recap"
    >
      <CardContent className="space-y-4 p-5">
        <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground/80">
          <Check className="h-3 w-3 text-emerald-400" />
          Appels synchronisés sur 30 jours
        </div>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <StatTile label="Total" value={data.stats.total.toString()} />
          <StatTile label="Manqués" value={data.stats.missed.toString()} />
          <StatTile
            label="Durée moy."
            value={formatDuration(data.stats.avgDurationSec)}
          />
          <StatTile
            label="Taux de réponse"
            value={`${Math.round(data.stats.answerRate * 100)}%`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          <a
            href={`/workspaces/${workspaceId}/live`}
            className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
            data-testid="voip-link-live"
          >
            Voir les appels dans En direct →
          </a>
          <a
            href={`/workspaces/${workspaceId}/explore?filters=event_name%3Dphone_call`}
            className="inline-flex items-center gap-2 text-sm text-primary hover:underline"
          >
            Filtrer dans Explorer →
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/40 bg-background/30 p-3">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m${s.toString().padStart(2, '0')}`;
}

// ─── Credential card ─────────────────────────────────────────────────────

function CredentialCard({
  workspaceId,
  cred,
  onChanged,
}: {
  workspaceId: string;
  cred: CredentialView;
  onChanged: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [testMsg, setTestMsg] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      const r = await testCredential(workspaceId, cred.kind);
      setTestMsg({ ok: r.ok, message: r.message });
      onChanged();
    } catch (err) {
      setTestMsg({
        ok: false,
        message:
          err instanceof BridgeApiError
            ? err.message
            : 'Test impossible.',
      });
    } finally {
      setTesting(false);
    }
  }, [workspaceId, cred.kind, onChanged]);

  const runDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await deleteCredential(workspaceId, cred.kind);
      onChanged();
    } catch {
      setDeleting(false);
    }
  }, [workspaceId, cred.kind, onChanged]);

  return (
    <div
      className="rounded-lg border border-border/50 bg-background/30 p-4"
      data-testid={`voip-cred-${cred.kind}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{cred.label}</span>
          <StatusBadge status={cred.status} />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={runTest}
            disabled={testing || deleting}
            data-testid={`voip-test-${cred.kind}`}
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Tester la connexion
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={runDelete}
            disabled={testing || deleting}
            data-testid={`voip-delete-${cred.kind}`}
            aria-label="Supprimer"
          >
            <Trash2 className="h-3.5 w-3.5 text-destructive" />
          </Button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {Object.entries(cred.masked).map(([k, v]) => (
          <span key={k}>
            {k}: <span className="tabular-nums">{v}</span>
          </span>
        ))}
      </div>
      {cred.lastSyncAt && (
        <p className="mt-2 text-[11px] text-muted-foreground/70">
          Dernière synchro : {formatDate(cred.lastSyncAt)}
        </p>
      )}
      {cred.lastError && !testMsg && (
        <p className="mt-2 text-xs text-destructive">{cred.lastError}</p>
      )}
      {testMsg && (
        <p
          className={cn(
            'mt-2 text-xs',
            testMsg.ok ? 'text-emerald-400' : 'text-destructive',
          )}
          data-testid={`voip-test-result-${cred.kind}`}
        >
          {testMsg.message}
        </p>
      )}
    </div>
  );
}

function CredentialForm({
  workspaceId,
  kind,
  fields,
  onSaved,
}: {
  workspaceId: string;
  kind: CredentialKind;
  fields: Array<{ name: string; label: string; placeholder: string }>;
  onSaved: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allFilled = fields.every((f) => (values[f.name] ?? '').trim().length > 0);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await saveCredential(workspaceId, kind, values);
        setValues({});
        onSaved();
      } catch (err) {
        setError(
          err instanceof BridgeApiError
            ? err.message
            : 'Enregistrement impossible.',
        );
      } finally {
        setSaving(false);
      }
    },
    [workspaceId, kind, values, onSaved],
  );

  return (
    <form onSubmit={submit} className="mt-3 space-y-3" data-testid="voip-form">
      {fields.map((f) => (
        <div key={f.name}>
          <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
            {f.label}
          </label>
          <input
            type="password"
            autoComplete="off"
            placeholder={f.placeholder}
            value={values[f.name] ?? ''}
            onChange={(e) =>
              setValues((v) => ({ ...v, [f.name]: e.target.value }))
            }
            className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm"
            data-testid={`voip-field-${f.name}`}
          />
        </div>
      ))}
      {error && <InlineError message={error} />}
      <Button
        type="submit"
        size="sm"
        disabled={saving || !allFilled}
        data-testid="voip-save-btn"
      >
        {saving && <Loader2 className="h-4 w-4 animate-spin" />}
        Enregistrer & chiffrer
      </Button>
      <p className="text-[11px] text-muted-foreground/70">
        Vos identifiants sont chiffrés (AES-256-GCM) avant stockage. Ils ne
        sont jamais réaffichés en clair.
      </p>
    </form>
  );
}

// ─── Primitives partagées ────────────────────────────────────────────────

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

function StatusBadge({ status }: { status: string }) {
  if (status === 'ok')
    return <Badge variant="success">Connexion OK</Badge>;
  if (status === 'failed')
    return <Badge variant="destructive">Échec</Badge>;
  return <Badge variant="warning">Non testé</Badge>;
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

function PanelSkeleton() {
  return (
    <div className="space-y-6" data-testid="voip-panel-skeleton">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg border border-border/50 bg-card/40"
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
        data-testid="voip-panel-error"
      >
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span className="font-medium">
            Impossible de charger les paramètres VoIP
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
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
