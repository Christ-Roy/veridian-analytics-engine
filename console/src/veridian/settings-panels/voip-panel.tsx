import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Hash,
  Info,
  Loader2,
  Pencil,
  Phone,
  Plus,
  RefreshCw,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../utils';
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
  type VoipSettingsResponse,
  type VoipCredentialKind as CredentialKind,
  type CredentialView,
  type PhoneSource,
  type TrackedPhoneNumber,
} from './voip-api';
import '../theme.css';

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
};

const SOURCE_BADGE_TONE: Record<PhoneSource, string> = {
  seo: 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300',
  ads: 'border-amber-400/40 bg-amber-400/10 text-amber-300',
  direct: 'border-sky-400/40 bg-sky-400/10 text-sky-300',
  email: 'border-violet-400/40 bg-violet-400/10 text-violet-300',
  social: 'border-pink-400/40 bg-pink-400/10 text-pink-300',
  print: 'border-orange-400/40 bg-orange-400/10 text-orange-300',
  other: 'border-zinc-400/40 bg-zinc-400/10 text-zinc-300',
};

/**
 * VoIPSettingsPanel — onglet « Téléphonie / VoIP » dans Settings native.
 *
 * Onglet dédié dans la sidebar Settings staminads (z.enum `'voip'`). C'est la
 * SEULE entrée d'accès à la gestion de la téléphonie : il n'y a pas de page
 * `/calls` dédiée, les appels remontent comme événements `phone_call` dans
 * les vues natives staminads (Live, Explore, Goals).
 *
 * Port natif (ticket 2026-06-16) : ce panel consomme les endpoints NATIFS de
 * l'engine (`/api/voip.*`, auth session console), plus le bridge. Il ne gère
 * que la CONFIG — connecter OVH/Telnyx, mapper numéros→sources, voir le statut
 * de synchro — JAMAIS une liste d'appels (vision Robert 2026-05-23).
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
  | { kind: 'ready'; data: VoipSettingsResponse };

export function VoIPSettingsPanel({ workspaceId }: VoIPSettingsPanelProps) {
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    fetchVoipSettings(workspaceId, { signal: ctrl.signal })
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

      {/* Sous-section "Numéros trackés" — 1 numéro = 1 source de trafic */}
      <TrackedNumbersSection workspaceId={workspaceId} />

      {/* Synchro manuelle + rappel : où voir les appels (vues natives) */}
      {hasConnectedCred && (
        <CallsHint workspaceId={workspaceId} onRefresh={onRefresh} />
      )}
    </>
  );
}

// ─── Numéros trackés (phone source dimension, 2026-05-25) ───────────────
//
// 1 numéro = 1 source de trafic. L'engine enrichit chaque event `phone_call`
// poussé en interne avec `properties.source` (SEO / Ads / direct / email
// / social / print / other) après lookup `(workspace, toNumber)`. Les appels
// apparaissent dans Live/Explore/Goals staminads natifs, sans page custom.

function TrackedNumbersSection({ workspaceId }: { workspaceId: string }) {
  const [collapsed, setCollapsed] = useState(false);
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'error'; error: Error }
    | { kind: 'ready'; rows: TrackedPhoneNumber[]; allowedSources: PhoneSource[] }
  >({ kind: 'loading' });
  const [editing, setEditing] = useState<{
    mode: 'create' | 'edit';
    row?: TrackedPhoneNumber;
  } | null>(null);

  const load = useCallback(() => {
    setState({ kind: 'loading' });
    fetchPhoneNumbers(workspaceId)
      .then((res) =>
        setState({
          kind: 'ready',
          rows: res.phoneNumbers,
          allowedSources: res.allowedSources,
        }),
      )
      .catch((err: Error) => setState({ kind: 'error', error: err }));
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card
      className="veridian-fade-in-delay-1 border-border/60 bg-card/80"
      data-testid="settings-section-phone-numbers"
    >
      <CardContent className="space-y-4 p-6 sm:p-7">
        <button
          type="button"
          className="flex w-full items-start gap-3 text-left"
          onClick={() => setCollapsed((c) => !c)}
          data-testid="phone-numbers-toggle"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Hash className="h-5 w-5" />
          </div>
          <div className="flex-1 space-y-0.5">
            <h2 className="text-lg font-semibold tracking-tight">
              Numéros trackés
            </h2>
            <p className="text-sm text-muted-foreground">
              Associez chaque numéro de téléphone affiché sur vos supports à
              sa source. Par exemple : votre numéro SEO sur le site web →
              «&nbsp;SEO&nbsp;», votre numéro Google Ads → «&nbsp;Ads&nbsp;».
              Chaque appel sera automatiquement attribué à sa source dans les
              goals.
            </p>
          </div>
          <div className="pt-1 text-muted-foreground">
            {collapsed ? (
              <ChevronRight className="h-5 w-5" />
            ) : (
              <ChevronDown className="h-5 w-5" />
            )}
          </div>
        </button>

        {!collapsed && (
          <div className="space-y-4">
            {state.kind === 'loading' && (
              <div className="h-24 animate-pulse rounded-lg border border-border/50 bg-card/40" />
            )}
            {state.kind === 'error' && (
              <PanelError error={state.error} onRetry={load} />
            )}
            {state.kind === 'ready' && (
              <>
                {state.rows.length === 0 ? (
                  <EmptyTrackedNumbers
                    onAdd={() => setEditing({ mode: 'create' })}
                  />
                ) : (
                  <TrackedNumbersTable
                    rows={state.rows}
                    onEdit={(row) => setEditing({ mode: 'edit', row })}
                    onDelete={async (row) => {
                      try {
                        await deletePhoneNumber(workspaceId, row.id);
                        load();
                      } catch {
                        /* fail-soft : on garde la row, l'erreur s'affiche au prochain reload */
                      }
                    }}
                  />
                )}
                <div className="flex justify-end">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setEditing({ mode: 'create' })}
                    data-testid="phone-numbers-add-btn"
                  >
                    <Plus className="h-4 w-4" />
                    Ajouter un numéro
                  </Button>
                </div>
              </>
            )}

            {editing && state.kind === 'ready' && (
              <PhoneNumberModal
                workspaceId={workspaceId}
                mode={editing.mode}
                row={editing.row}
                allowedSources={state.allowedSources}
                onClose={() => setEditing(null)}
                onSaved={() => {
                  setEditing(null);
                  load();
                }}
              />
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EmptyTrackedNumbers({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      className="rounded-lg border border-dashed border-border/60 bg-background/20 p-6 text-center"
      data-testid="phone-numbers-empty"
    >
      <p className="text-sm text-muted-foreground">
        Aucun numéro tracké pour le moment. Tant qu'un numéro n'est pas
        associé à une source, ses appels seront comptabilisés comme
        «&nbsp;direct&nbsp;».
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="mt-3"
        onClick={onAdd}
      >
        <Plus className="h-4 w-4" />
        Ajouter votre premier numéro
      </Button>
    </div>
  );
}

function TrackedNumbersTable({
  rows,
  onEdit,
  onDelete,
}: {
  rows: TrackedPhoneNumber[];
  onEdit: (row: TrackedPhoneNumber) => void;
  onDelete: (row: TrackedPhoneNumber) => void;
}) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-border/50"
      data-testid="phone-numbers-table"
    >
      <table className="w-full text-sm">
        <thead className="bg-background/40 text-[11px] uppercase tracking-wider text-muted-foreground/70">
          <tr>
            <th className="px-4 py-2 text-left">Numéro</th>
            <th className="px-4 py-2 text-left">Source</th>
            <th className="px-4 py-2 text-left">Libellé</th>
            <th className="px-4 py-2 text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className="border-t border-border/40"
              data-testid={`phone-numbers-row-${row.id}`}
            >
              <td className="px-4 py-2 font-mono text-sm tabular-nums">
                {row.e164}
              </td>
              <td className="px-4 py-2">
                <span
                  className={cn(
                    'inline-flex rounded-full border px-2 py-0.5 text-[11px] font-medium',
                    SOURCE_BADGE_TONE[row.source] ??
                      SOURCE_BADGE_TONE.other,
                  )}
                >
                  {SOURCE_LABELS[row.source] ?? row.source}
                </span>
              </td>
              <td className="px-4 py-2 text-muted-foreground">
                {row.label ?? '—'}
              </td>
              <td className="px-4 py-2 text-right">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(row)}
                  aria-label="Modifier"
                  data-testid={`phone-numbers-edit-${row.id}`}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onDelete(row)}
                  aria-label="Supprimer"
                  data-testid={`phone-numbers-delete-${row.id}`}
                >
                  <Trash2 className="h-3.5 w-3.5 text-destructive" />
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PhoneNumberModal({
  workspaceId,
  mode,
  row,
  allowedSources,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  mode: 'create' | 'edit';
  row?: TrackedPhoneNumber;
  allowedSources: PhoneSource[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [e164, setE164] = useState(row?.e164 ?? '');
  const [source, setSource] = useState<PhoneSource>(row?.source ?? 'seo');
  const [label, setLabel] = useState(row?.label ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        if (mode === 'create') {
          await createPhoneNumber(workspaceId, {
            e164: e164.trim(),
            source,
            label: label.trim() || null,
          });
        } else if (row) {
          await updatePhoneNumber(workspaceId, row.id, {
            source,
            label: label.trim() || null,
          });
        }
        onSaved();
      } catch (err) {
        if (err instanceof VoipApiError) {
          if (err.code === 'invalid_e164') {
            setError(
              'Format de numéro invalide. Saisissez un numéro E.164, par exemple +33177123456.',
            );
          } else if (err.code === 'already_exists') {
            setError('Ce numéro est déjà enregistré pour ce workspace.');
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
    [mode, row, workspaceId, e164, source, label, onSaved],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      data-testid="phone-numbers-modal"
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-md border-border/70 bg-card shadow-xl">
        <CardContent className="space-y-4 p-6">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-lg font-semibold">
              {mode === 'create'
                ? 'Ajouter un numéro'
                : 'Modifier le numéro'}
            </h3>
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
                Numéro (E.164)
              </label>
              <input
                type="tel"
                value={e164}
                onChange={(e) => setE164(e.target.value)}
                placeholder="+33177123456"
                disabled={mode === 'edit'}
                className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 font-mono text-sm disabled:opacity-60"
                data-testid="phone-numbers-field-e164"
                required
              />
              {mode === 'edit' && (
                <p className="mt-1 text-[11px] text-muted-foreground/70">
                  Le numéro ne peut pas être modifié. Pour le changer,
                  supprimez puis recréez l'entrée.
                </p>
              )}
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
                Source
              </label>
              <select
                value={source}
                onChange={(e) => setSource(e.target.value as PhoneSource)}
                className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm"
                data-testid="phone-numbers-field-source"
              >
                {allowedSources.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s] ?? s}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-muted-foreground/70">
                Libellé (optionnel)
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Ligne SEO, campagne été…"
                maxLength={120}
                className="mt-1 w-full rounded-md border border-border/60 bg-background/60 px-3 py-2 text-sm"
                data-testid="phone-numbers-field-label"
              />
            </div>

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
                disabled={saving || (mode === 'create' && !e164.trim())}
                data-testid="phone-numbers-save-btn"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === 'create' ? 'Ajouter' : 'Enregistrer'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
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
  workspaceId: string;
  onRefresh: () => void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const runSync = useCallback(async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const r = await syncNow(workspaceId);
      const n = r.pushedEvents;
      setSyncResult({
        ok: true,
        message:
          n === 0
            ? 'Synchro terminée : aucun nouvel appel à remonter.'
            : `Synchro terminée : ${n} appel${n > 1 ? 's' : ''} remonté${
                n > 1 ? 's' : ''
              }.`,
      });
      // Rafraîchit le panel pour mettre à jour « Dernière synchro ».
      onRefresh();
    } catch (err) {
      setSyncResult({
        ok: false,
        message:
          err instanceof VoipApiError
            ? err.message
            : 'Synchro impossible. Réessayez dans un instant.',
      });
    } finally {
      setSyncing(false);
    }
  }, [workspaceId, onRefresh]);

  return (
    <Card
      className="veridian-fade-in-delay-2 border-border/60 bg-card/60"
      data-testid="voip-calls-hint"
    >
      <CardContent className="space-y-4 p-5">
        <p className="text-sm text-muted-foreground">
          Vos appels remontent automatiquement comme objectifs
          «&nbsp;phone_call&nbsp;» et apparaissent dans vos vues d'analyse,
          attribués à leur source.
        </p>

        {/* Déclencheur de synchro manuelle + feedback */}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            onClick={runSync}
            disabled={syncing}
            data-testid="voip-sync-now-btn"
          >
            {syncing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            Synchroniser maintenant
          </Button>
          {syncResult && (
            <span
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                syncResult.ok ? 'text-emerald-400' : 'text-destructive',
              )}
              data-testid="voip-sync-result"
            >
              {syncResult.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
              {syncResult.message}
            </span>
          )}
        </div>

        {/* État de la synchro automatique (cron natif, gated VOIP_SYNC_ENABLED) */}
        <div
          className="flex items-start gap-2 rounded-md border border-border/50 bg-background/30 px-3 py-2 text-[11px] text-muted-foreground"
          data-testid="voip-autosync-hint"
        >
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            La synchro automatique remonte vos appels toutes les 15 minutes
            (si elle est activée sur votre instance). En cas de doute juste
            après une configuration, utilisez «&nbsp;Synchroniser
            maintenant&nbsp;».
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-3 pt-1">
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
          err instanceof VoipApiError
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
          err instanceof VoipApiError
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
