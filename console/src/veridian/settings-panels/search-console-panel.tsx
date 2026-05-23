import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, Search, Trash2 } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { cn } from '../utils';
import {
  fetchTenantSettings,
  BridgeApiError,
  type TenantSettingsResponse,
} from '../api';
import { fetchGscDashboard } from '../gsc/api';
import { KpiTile } from '../gsc/kpi-tile';
import { TimeSeriesChart } from '../gsc/time-series-chart';
import { GscDataTable } from '../gsc/data-table';
import {
  DATE_RANGES,
  DIMENSION_META,
  type GscDashboardResponse,
  type MetricKey,
} from '../gsc/types';
import '../theme.css';

/**
 * SearchConsoleSettingsPanel — onglet « Search Console » dans Settings native.
 *
 * Onglet dédié dans la sidebar Settings staminads (z.enum `'search-console'`).
 * Robert : « pas de page dédiée Search Console — un onglet Settings dense qui
 * contient tout ». C'est la SEULE place où GSC vit dans l'app, donc on a
 * réuni ici :
 *
 *   1. Status connexion + bouton « Connecter Search Console » (OAuth Google)
 *      ou « Déconnecter / Resync maintenant » si déjà branché.
 *   2. KPIs cliquables (clics, impressions, CTR, position) sur la fenêtre choisie.
 *   3. Graphique temporel multi-courbes.
 *   4. Onglets Mots-clés / Pages avec data-table triable.
 *
 * Si pas connecté → la partie « data » disparaît, seul le CTA OAuth s'affiche.
 *
 * Pourquoi tout est dense ici plutôt que dans une page séparée : l'app
 * native staminads doit rester centrée sur ses vues (Tableau de bord, En
 * direct, Explorer, Objectifs, Filtres, Annotations). Les features Veridian
 * sont des « onglets de paramètres » qui enrichissent le dashboard natif.
 */

export interface SearchConsoleSettingsPanelProps {
  workspaceId: string;
  /** Domaine du site (fallback `{workspaceId}.veridian.site`). */
  siteDomain?: string;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: TenantSettingsResponse };

export function SearchConsoleSettingsPanel({
  workspaceId,
  siteDomain,
}: SearchConsoleSettingsPanelProps) {
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
      data-testid="search-console-settings-panel"
    >
      <div className="space-y-6">
        {state.kind === 'loading' && <PanelSkeleton />}
        {state.kind === 'error' && (
          <PanelError error={state.error} onRetry={load} />
        )}
        {state.kind === 'ready' && (
          <>
            <GscConnectionSection
              workspaceId={workspaceId}
              gsc={state.data.gsc}
              onRefresh={load}
            />
            {state.data.gsc.connected && (
              <GscInlineData
                workspaceId={workspaceId}
                siteDomain={
                  siteDomain ??
                  state.data.gsc.propertyUrl ??
                  `${workspaceId}.veridian.site`
                }
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── 1. Connexion / déconnexion / resync ─────────────────────────────────

function GscConnectionSection({
  workspaceId,
  gsc,
  onRefresh,
}: {
  workspaceId: string;
  gsc: TenantSettingsResponse['gsc'];
  onRefresh: () => void;
}) {
  const [busy, setBusy] = useState<null | 'connect' | 'resync' | 'disconnect'>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setBusy('connect');
    setError(null);
    try {
      const { fetchOauthBeginUrl } = await import('../pages/settings-helpers');
      const url = await fetchOauthBeginUrl(workspaceId);
      window.location.href = url;
    } catch (err) {
      setError(
        err instanceof BridgeApiError
          ? err.message
          : 'Impossible de démarrer la connexion Search Console.',
      );
      setBusy(null);
    }
  }, [workspaceId]);

  const resync = useCallback(async () => {
    setBusy('resync');
    setError(null);
    try {
      const { triggerGscResync } = await import('../pages/settings-helpers');
      await triggerGscResync(workspaceId);
      onRefresh();
    } catch (err) {
      setError(
        err instanceof BridgeApiError
          ? err.message
          : 'Resynchronisation impossible.',
      );
    } finally {
      setBusy(null);
    }
  }, [workspaceId, onRefresh]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    setError(null);
    try {
      const { disconnectGsc } = await import('../pages/settings-helpers');
      await disconnectGsc(workspaceId);
      onRefresh();
    } catch (err) {
      setError(
        err instanceof BridgeApiError
          ? err.message
          : 'Déconnexion impossible.',
      );
    } finally {
      setBusy(null);
    }
  }, [workspaceId, onRefresh]);

  return (
    <Section
      icon={Search}
      title="Google Search Console"
      description="Connectez votre Search Console pour suivre vos requêtes, vos positions Google et repérer les pages qui montent."
      testId="settings-section-gsc"
    >
      {gsc.connected ? (
        <div
          className="rounded-lg border border-emerald-400/30 bg-emerald-400/5 p-4"
          data-testid="gsc-connected"
        >
          <div className="flex flex-wrap items-center gap-2">
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
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={resync}
              disabled={busy !== null}
              data-testid="gsc-resync-btn"
            >
              {busy === 'resync' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Resynchroniser maintenant
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={disconnect}
              disabled={busy !== null}
              data-testid="gsc-disconnect-btn"
            >
              {busy === 'disconnect' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4 text-destructive" />
              )}
              Déconnecter
            </Button>
          </div>
        </div>
      ) : (
        <div data-testid="gsc-disconnected" className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Veridian lira votre Search Console en lecture seule. Vous n'avez
            pas de clé à saisir — il suffit d'autoriser l'accès via votre
            compte Google.
          </p>
          <Button
            type="button"
            onClick={connect}
            disabled={busy !== null}
            data-testid="gsc-connect-btn"
          >
            {busy === 'connect' && <Loader2 className="h-4 w-4 animate-spin" />}
            Connecter Search Console
          </Button>
        </div>
      )}
      {error && <InlineError message={error} />}
    </Section>
  );
}

// ─── 2. Vue inline GSC : KPIs + chart + top mots-clés/pages ──────────────

type Tab = 'query' | 'page';

function GscInlineData({
  workspaceId,
  siteDomain,
}: {
  workspaceId: string;
  siteDomain: string;
}) {
  const [rangeKey, setRangeKey] = useState<string>('28d');
  const [activeMetrics, setActiveMetrics] = useState<
    Record<MetricKey, boolean>
  >({
    clicks: true,
    impressions: true,
    ctr: false,
    position: false,
  });
  const [activeTab, setActiveTab] = useState<Tab>('query');
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'not-connected' }
    | { kind: 'error'; error: Error }
    | { kind: 'ready'; data: GscDashboardResponse }
  >({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);

  const days = useMemo(
    () => DATE_RANGES.find((r) => r.value === rangeKey)?.days ?? 28,
    [rangeKey],
  );

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    fetchGscDashboard(workspaceId, days, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        if (!data.property) {
          setState({ kind: 'not-connected' });
          return;
        }
        setState({ kind: 'ready', data });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        if (err instanceof BridgeApiError && err.status === 404) {
          setState({ kind: 'not-connected' });
          return;
        }
        setState({ kind: 'error', error: err });
      });
  }, [workspaceId, days]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const toggleMetric = (m: MetricKey) => {
    setActiveMetrics((prev) => {
      const next = { ...prev, [m]: !prev[m] };
      const anyActive = Object.values(next).some(Boolean);
      if (!anyActive) return prev;
      return next;
    });
  };

  if (state.kind === 'loading') return <InlineSkeleton />;
  if (state.kind === 'not-connected') {
    // Le tenant a connecté GSC dans `gsc.connected=true` mais le bridge n'a
    // pas encore de propriété rattachée — état transitoire ; on incite au resync.
    return (
      <Card className="border-dashed border-border/60 bg-card/60">
        <CardContent
          className="space-y-2 p-6 text-center"
          data-testid="gsc-inline-not-ready"
        >
          <p className="text-sm text-muted-foreground">
            Vos données Search Console sont en cours de première
            synchronisation pour {siteDomain}. Revenez dans quelques minutes
            ou cliquez sur « Resynchroniser maintenant » ci-dessus.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (state.kind === 'error') {
    return (
      <Card className="border-border/60 bg-card/80">
        <CardContent
          className="flex flex-col items-start gap-3 p-6"
          data-testid="gsc-inline-error"
        >
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <span className="font-medium">Search Console indisponible</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {state.error.message}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-4 w-4" />
            Réessayer
          </Button>
        </CardContent>
      </Card>
    );
  }

  const { data } = state;
  const seriesData = {
    clicks: data.timeseries.map((r) => ({ day: r.keys[0], value: r.clicks })),
    impressions: data.timeseries.map((r) => ({
      day: r.keys[0],
      value: r.impressions,
    })),
    ctr: data.timeseries.map((r) => ({ day: r.keys[0], value: r.ctr })),
    position: data.timeseries.map((r) => ({
      day: r.keys[0],
      value: r.position,
    })),
  };

  return (
    <Card
      className="veridian-fade-in-delay-2 border-border/60 bg-card/80"
      data-testid="gsc-inline-data"
    >
      <CardContent className="space-y-6 p-6 sm:p-7">
        {/* Sélecteur de fenêtre */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h3 className="text-base font-semibold">
              Performances Search Console
            </h3>
            <p className="text-xs text-muted-foreground">
              Propriété : {data.property?.siteUrl ?? siteDomain}
            </p>
          </div>
          <select
            value={rangeKey}
            onChange={(e) => setRangeKey(e.target.value)}
            data-testid="gsc-range-selector"
            className="h-9 rounded-md border border-input bg-transparent px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {DATE_RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* 4 KPI tiles cliquables */}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiTile
            metric="clicks"
            value={data.totals.clicks}
            active={activeMetrics.clicks}
            onToggle={() => toggleMetric('clicks')}
          />
          <KpiTile
            metric="impressions"
            value={data.totals.impressions}
            active={activeMetrics.impressions}
            onToggle={() => toggleMetric('impressions')}
          />
          <KpiTile
            metric="ctr"
            value={data.totals.ctr}
            active={activeMetrics.ctr}
            onToggle={() => toggleMetric('ctr')}
          />
          <KpiTile
            metric="position"
            value={data.totals.position}
            active={activeMetrics.position}
            onToggle={() => toggleMetric('position')}
          />
        </div>

        {/* Chart temporel multi-courbes */}
        <TimeSeriesChart series={seriesData} activeMetrics={activeMetrics} />

        {/* Onglets dimensions : query / page */}
        <div className="flex flex-wrap gap-1 border-b border-border">
          {(['query', 'page'] as Tab[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setActiveTab(d)}
              data-testid={`gsc-tab-${d}`}
              className={cn(
                'relative rounded-t-md px-4 py-2 text-sm transition-colors',
                activeTab === d
                  ? '-mb-px border border-border border-b-card bg-card text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <span className="mr-1">{DIMENSION_META[d].icon}</span>
              {DIMENSION_META[d].label}
            </button>
          ))}
        </div>

        <GscDataTable
          rows={activeTab === 'query' ? data.topQueries : data.topPages}
          dimensionLabel={DIMENSION_META[activeTab].label}
        />
      </CardContent>
    </Card>
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
    <div className="space-y-6" data-testid="gsc-panel-skeleton">
      {[0, 1].map((i) => (
        <div
          key={i}
          className="h-40 animate-pulse rounded-lg border border-border/50 bg-card/40"
        />
      ))}
    </div>
  );
}

function InlineSkeleton() {
  return (
    <Card className="border-border/60 bg-card/80">
      <CardContent className="space-y-6 p-6 sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <div className="veridian-skeleton h-5 w-48 rounded" />
          <div className="veridian-skeleton h-9 w-44 rounded-md" />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-lg border border-border bg-card p-4"
            >
              <div className="veridian-skeleton h-3 w-20 rounded" />
              <div className="veridian-skeleton mt-3 h-8 w-24 rounded" />
            </div>
          ))}
        </div>
        <div className="veridian-skeleton h-[260px] w-full rounded-lg" />
      </CardContent>
    </Card>
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
        data-testid="gsc-panel-error"
      >
        <div className="flex items-center gap-2 text-destructive">
          <AlertTriangle className="h-5 w-5" />
          <span className="font-medium">
            Impossible de charger les paramètres Search Console
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
