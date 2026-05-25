import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Check,
  Copy,
  Loader2,
  Phone,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Trash2,
  User,
} from 'lucide-react';
import { Card, CardContent } from '../../ui/card';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { cn } from '../../utils';
import {
  fetchTenantSettings,
  updateTenantSettings,
  saveCredential,
  testCredential,
  deleteCredential,
  BridgeApiError,
  type TenantSettingsResponse,
  type SettingsUpdatePayload,
  type CredentialKind,
  type CredentialView,
} from '../../api';
import '../../theme.css';

/**
 * VeridianSettingsPage — page Settings tenant self-service (U8).
 *
 * Cinq sections : Compte, Site & tracking, Google Search Console, VoIP, et
 * Notifications. C'est la page la plus importante côté autonomie client : le
 * tenant gère SA config (notamment ses credentials GSC + VoIP) sans passer
 * par Robert.
 *
 * Architecture :
 *   - Fetch initial `GET /api/admin/tenant/:wsId/settings` → vue complète
 *   - Mutations optimistes par section (PUT settings / POST credentials / ...)
 *   - Tout scopé sous `.veridian-scope` — ne pollue pas le thème AntDesign
 *
 * Sécurité : la page n'affiche JAMAIS les credentials en clair — l'API ne
 * renvoie que des valeurs masquées (`••••1234`). La saisie d'un nouveau
 * credential remplace l'ancien (les champs sont vidés après envoi).
 */

export interface VeridianSettingsPageProps {
  workspaceId: string;
  /** Email du compte connecté — affiché en lecture dans la section Compte. */
  accountEmail?: string;
  /**
   * URL absolue de l'endpoint staminads de gestion du compte (changer email
   * / mot de passe). Quand fourni, la section Compte affiche un lien vers
   * cette page plutôt que de réimplémenter le flow auth.
   */
  accountSettingsUrl?: string;
  /**
   * Mode "embarqué" : retire le header (`<SettingsHeader />`), le padding
   * outer + le `min-h-screen`. Utilisé quand la page est incrustée dans
   * un layout hôte (sidebar staminads native settings) qui fournit déjà
   * son propre titre + son propre cadre. Default false = mode standalone.
   */
  embedded?: boolean;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: TenantSettingsResponse };

export function VeridianSettingsPage({
  workspaceId,
  accountEmail,
  accountSettingsUrl,
  embedded = false,
}: VeridianSettingsPageProps) {
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

  /** Remplace la donnée affichée après une mutation réussie. */
  const onUpdated = useCallback((data: TenantSettingsResponse) => {
    setState({ kind: 'ready', data });
  }, []);

  return (
    <div
      className={cn(
        'veridian-scope',
        embedded
          ? 'w-full'
          : 'min-h-screen px-4 py-8 sm:px-6 lg:px-10',
      )}
      data-testid="veridian-settings-root"
      data-embedded={embedded ? 'true' : 'false'}
    >
      <div
        className={cn(
          'space-y-8',
          embedded ? 'w-full' : 'mx-auto max-w-4xl',
        )}
      >
        {!embedded && <SettingsHeader />}

        {state.kind === 'loading' && <SettingsSkeleton />}

        {state.kind === 'error' && (
          <SettingsError error={state.error} onRetry={load} />
        )}

        {state.kind === 'ready' && (
          <div className="space-y-6">
            <AccountSection
              email={accountEmail}
              tenantName={state.data.tenant.name}
              plan={state.data.tenant.plan}
              accountSettingsUrl={accountSettingsUrl}
            />
            <SiteSection sites={state.data.sites} />
            <GscSection
              workspaceId={workspaceId}
              gsc={state.data.gsc}
              onRefresh={load}
            />
            <VoipSection
              workspaceId={workspaceId}
              credentials={state.data.credentials}
              onRefresh={load}
            />
            <NotificationsSection
              workspaceId={workspaceId}
              notifications={state.data.notifications}
              tracking={state.data.tracking}
              onUpdated={onUpdated}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────

function SettingsHeader() {
  return (
    <header
      className="veridian-fade-in space-y-1"
      data-testid="settings-header"
    >
      <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
        <Sparkles className="h-3 w-3 text-primary" />
        Veridian Analytics
      </div>
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Paramètres
      </h1>
      <p className="text-sm text-muted-foreground">
        Gérez votre compte, votre tracking et vos connexions externes.
      </p>
    </header>
  );
}

// ─── Section wrapper ─────────────────────────────────────────────────────

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

// ─── 1. Compte ───────────────────────────────────────────────────────────

function AccountSection({
  email,
  tenantName,
  plan,
  accountSettingsUrl,
}: {
  email?: string;
  tenantName: string;
  plan: string;
  accountSettingsUrl?: string;
}) {
  return (
    <Section
      icon={User}
      title="Compte"
      description="Votre identité et votre formule Veridian."
      testId="settings-section-account"
    >
      <Field label="Espace">
        <span className="text-sm font-medium">{tenantName}</span>
      </Field>
      <Field label="Email">
        <span className="text-sm">{email ?? '—'}</span>
      </Field>
      <Field label="Formule">
        <Badge variant="secondary" className="capitalize">
          {plan}
        </Badge>
      </Field>
      <div className="pt-1">
        {accountSettingsUrl ? (
          <a href={accountSettingsUrl}>
            <Button variant="outline" size="sm">
              Changer email / mot de passe
            </Button>
          </a>
        ) : (
          <p className="text-xs text-muted-foreground">
            La gestion de l'email et du mot de passe se fait depuis votre
            compte Veridian.
          </p>
        )}
      </div>
    </Section>
  );
}

// ─── 2. Site & tracking ──────────────────────────────────────────────────

function SiteSection({
  sites,
}: {
  sites: TenantSettingsResponse['sites'];
}) {
  return (
    <Section
      icon={SettingsIcon}
      title="Site & tracking"
      description="Vos domaines suivis et leur clé de tracking."
      testId="settings-section-site"
    >
      {sites.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Aucun site rattaché pour le moment.
        </p>
      )}
      {sites.map((site) => (
        <div
          key={site.id}
          className="rounded-lg border border-border/50 bg-background/30 p-4"
          data-testid={`settings-site-${site.id}`}
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-sm font-medium">{site.name}</span>
            <span className="text-xs text-muted-foreground">{site.domain}</span>
          </div>
          <div className="mt-3">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
              Clé de tracking (siteKey)
            </span>
            <CopyableValue value={site.siteKey} />
          </div>
        </div>
      ))}
    </Section>
  );
}

function CopyableValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [value]);
  return (
    <div className="mt-1 flex items-center gap-2">
      <code className="flex-1 truncate rounded-md border border-border/50 bg-background/50 px-2.5 py-1.5 text-xs tabular-nums">
        {value}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={copy}
        data-testid="copy-sitekey"
        aria-label="Copier la clé"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-emerald-400" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
        {copied ? 'Copié' : 'Copier'}
      </Button>
    </div>
  );
}

// ─── 3. Google Search Console ────────────────────────────────────────────

function GscSection({
  workspaceId,
  gsc,
  onRefresh,
}: {
  workspaceId: string;
  gsc: TenantSettingsResponse['gsc'];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // POST oauth-begin renvoie l'URL Google consent à ouvrir.
      const { fetchOauthBeginUrl } = await import('../../pages/settings-helpers');
      const url = await fetchOauthBeginUrl(workspaceId);
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof BridgeApiError
          ? err.message
          : 'Impossible de démarrer la connexion Search Console.',
      );
      setBusy(false);
    }
  }, [workspaceId]);

  return (
    <Section
      icon={Search}
      title="Google Search Console"
      description="Connectez votre Search Console pour suivre vos requêtes et positions."
      testId="settings-section-gsc"
    >
      {gsc.connected ? (
        <div
          className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4"
          data-testid="gsc-connected"
        >
          <div className="flex items-center gap-2">
            <Badge variant="success">Connecté</Badge>
            {gsc.propertyUrl && (
              <span className="text-sm text-muted-foreground">
                {gsc.propertyUrl}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Dernière synchro :{' '}
            {gsc.lastSyncAt ? formatDate(gsc.lastSyncAt) : 'jamais'}
          </p>
        </div>
      ) : (
        <div data-testid="gsc-disconnected" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Veridian lira votre Search Console en lecture seule. Vous
            n'avez pas de clé à saisir — il suffit d'autoriser l'accès via
            votre compte Google.
          </p>
          <Button
            type="button"
            onClick={connect}
            disabled={busy}
            data-testid="gsc-connect-btn"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Connecter Search Console
          </Button>
        </div>
      )}
      {error && <InlineError message={error} />}
      <button
        type="button"
        onClick={onRefresh}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        Rafraîchir le statut
      </button>
    </Section>
  );
}

// ─── 4. VoIP / Téléphonie ────────────────────────────────────────────────

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

function VoipSection({
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

  return (
    <Section
      icon={Phone}
      title="VoIP / Téléphonie"
      description="Branchez votre opérateur pour remonter vos appels dans Veridian."
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
  );
}

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
            Tester
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

// ─── 5. Notifications ────────────────────────────────────────────────────

function NotificationsSection({
  workspaceId,
  notifications,
  tracking,
  onUpdated,
}: {
  workspaceId: string;
  notifications: TenantSettingsResponse['notifications'];
  tracking: TenantSettingsResponse['tracking'];
  onUpdated: (data: TenantSettingsResponse) => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = useCallback(
    async (key: string, update: SettingsUpdatePayload) => {
      setSaving(key);
      setError(null);
      try {
        const data = await updateTenantSettings(workspaceId, update);
        onUpdated(data);
      } catch (err) {
        setError(
          err instanceof BridgeApiError
            ? err.message
            : 'Mise à jour impossible.',
        );
      } finally {
        setSaving(null);
      }
    },
    [workspaceId, onUpdated],
  );

  return (
    <Section
      icon={Bell}
      title="Notifications"
      description="Choisissez ce que Veridian vous envoie."
      testId="settings-section-notifications"
    >
      <ToggleRow
        label="Nouveau lead"
        hint="Un email à chaque formulaire rempli sur votre site."
        checked={notifications.notifyNewLead}
        busy={saving === 'notifyNewLead'}
        onChange={(v) => patch('notifyNewLead', { notifyNewLead: v })}
        testId="toggle-notify-new-lead"
      />
      <ToggleRow
        label="Rapport hebdomadaire"
        hint="Un récap de votre trafic chaque semaine."
        checked={notifications.notifyWeeklyReport}
        busy={saving === 'notifyWeeklyReport'}
        onChange={(v) =>
          patch('notifyWeeklyReport', { notifyWeeklyReport: v })
        }
        testId="toggle-notify-weekly"
      />
      <ToggleRow
        label="Notifications admin (push)"
        hint="Alertes dans le dashboard."
        checked={notifications.pushAdminEnabled}
        busy={saving === 'pushAdminEnabled'}
        onChange={(v) => patch('pushAdminEnabled', { pushAdminEnabled: v })}
        testId="toggle-push-admin"
      />
      <div className="border-t border-border/50 pt-4">
        <ToggleRow
          label="Identifiant visiteur (visitor_id)"
          hint="Relie les visites d'un même visiteur entre elles."
          checked={tracking.visitorIdEnabled}
          busy={saving === 'visitorIdEnabled'}
          onChange={(v) => patch('visitorIdEnabled', { visitorIdEnabled: v })}
          testId="toggle-visitor-id"
        />
        <ToggleRow
          label="Bandeau de consentement cookies"
          hint="Affiche un bandeau de consentement sur votre site."
          checked={tracking.cookieConsentEnabled}
          busy={saving === 'cookieConsentEnabled'}
          onChange={(v) =>
            patch('cookieConsentEnabled', { cookieConsentEnabled: v })
          }
          testId="toggle-cookie-consent"
        />
      </div>
      {error && <InlineError message={error} />}
    </Section>
  );
}

// ─── Primitives ──────────────────────────────────────────────────────────

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[11px] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </span>
      {children}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  busy,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  busy?: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
      <div className="space-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={busy}
        onClick={() => onChange(!checked)}
        data-testid={testId}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted',
          busy && 'opacity-50',
        )}
      >
        <span
          className={cn(
            'inline-block h-4 w-4 transform rounded-full bg-background transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
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

function SettingsSkeleton() {
  return (
    <div className="space-y-6" data-testid="settings-skeleton">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg border border-border/50 bg-card/40"
        />
      ))}
    </div>
  );
}

function SettingsError({
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
        data-testid="settings-error"
      >
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span className="font-medium">Impossible de charger les paramètres</span>
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
