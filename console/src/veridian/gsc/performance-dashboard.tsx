import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, RefreshCw, Search } from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { cn } from '../utils';
import { BridgeApiError } from '../api';
import { KpiTile } from './kpi-tile';
import { TimeSeriesChart } from './time-series-chart';
import { GscDataTable } from './data-table';
import { fetchGscDashboard } from './api';
import {
  DATE_RANGES,
  DIMENSION_META,
  type GscDashboardResponse,
  type MetricKey,
} from './types';

/**
 * Vue principale Search Console — composant orchestrateur.
 *
 * Consomme `GET /api/admin/tenant/:wsId/gsc?days=N` du bridge (handler
 * `dashboardSummary`, livré par A4). Le bridge fait déjà le boulot lourd :
 * agrégation server-side, top 50 mots-clés/pages, série temporelle.
 *
 * États gérés :
 *   - `loading` initial         → skeleton shimmer
 *   - `not-connected`           → onboarding « Connectez votre GSC »
 *     (property: null) signale que le tenant n'a pas connecté son compte
 *   - `error`                   → carte d'erreur + bouton Réessayer
 *   - `ready` (data)            → vue complète : KPIs + chart + tabs query/page
 *
 * Adapté du legacy `veridian-analytics/components/gsc/performance-dashboard.tsx` :
 * - drop des filtres dynamiques GSC (les filtres legacy hitaient un endpoint
 *   custom `/api/gsc/query` qui n'est pas porté côté bridge — pas besoin pour
 *   la V1 commerciale, le filtre client sur la table suffit)
 * - on consomme l'endpoint summary unique au lieu de 4 requêtes parallèles
 */

type ViewState =
  | { kind: 'loading' }
  | { kind: 'not-connected' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: GscDashboardResponse };

type Tab = 'query' | 'page';

export function GscPerformanceDashboard({
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
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
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
        // 404 du bridge → endpoint A4 pas encore livré sur cet env → onboarding propre
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
      // Empêcher de tout désactiver — au moins une metric doit rester
      const anyActive = Object.values(next).some(Boolean);
      if (!anyActive) return prev;
      return next;
    });
  };

  if (state.kind === 'loading') return <GscSkeleton />;
  if (state.kind === 'not-connected')
    return <GscNotConnected siteDomain={siteDomain} />;
  if (state.kind === 'error')
    return <GscError error={state.error} onRetry={load} />;

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
    <div className="veridian-fade-in-delay-1 space-y-6" data-testid="gsc-dashboard">
      {/* Header : property + range selector */}
      <div className="flex flex-wrap items-center gap-3">
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="gsc-property"
        >
          <Search className="h-3.5 w-3.5 text-primary" />
          <span className="font-medium text-foreground">
            {data.property?.siteUrl}
          </span>
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
    </div>
  );
}

// ─── États ───────────────────────────────────────────────────────────────

function GscNotConnected({ siteDomain }: { siteDomain: string }) {
  const mailto = `mailto:contact@veridian.site?subject=${encodeURIComponent(
    'Veridian Analytics — connecter Search Console',
  )}&body=${encodeURIComponent(
    `Bonjour Robert,\n\nJe souhaite connecter ma propriété Google Search Console pour ${siteDomain}.\nMerci de m'envoyer la marche à suivre.\n\n--\nEnvoyé depuis mon dashboard Veridian`,
  )}`;
  return (
    <Card
      className="veridian-fade-in border-dashed border-border/60 bg-card/60"
      data-testid="gsc-not-connected"
    >
      <CardContent className="flex flex-col items-center gap-6 py-14 text-center">
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Search className="h-8 w-8" />
          <span className="absolute inset-0 rounded-full veridian-pulse-ring" />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-xl font-semibold">
            Connectez votre Search Console
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Découvrez sur quels mots-clés Google vous trouve, repérez les pages
            qui montent et celles qui décrochent. Une fois branchée, votre
            Search Console se synchronise toutes les nuits — vos données
            apparaîtront ici sans aller fouiller dans l'interface Google.
          </p>
        </div>
        <a
          href={mailto}
          data-testid="gsc-cta-mailto"
          className={cn(
            'inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground',
            'transition-transform hover:scale-[1.02]',
          )}
        >
          Connecter ma Search Console
        </a>
      </CardContent>
    </Card>
  );
}

function GscError({
  error,
  onRetry,
}: {
  error: Error;
  onRetry: () => void;
}) {
  const isApiError = error instanceof BridgeApiError;
  const status = isApiError ? error.status : null;
  const friendly =
    status === 401 || status === 403
      ? "Votre session n'a pas les droits pour consulter ces données. Reconnectez-vous ou contactez Robert."
      : status && status >= 500
        ? 'Le service Search Console est temporairement indisponible. Réessayez dans quelques instants.'
        : 'Impossible de charger les données Search Console. Vérifiez votre connexion et réessayez.';

  return (
    <Card
      className="veridian-fade-in border-border/60 bg-card/80"
      data-testid="gsc-error"
    >
      <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-xl font-semibold">Search Console indisponible</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {friendly}
          </p>
          {status && (
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
              Erreur {status} · {error.message}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={onRetry}
          data-testid="gsc-retry-button"
          className={cn(
            'inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary',
            'transition-colors hover:border-primary/70 hover:bg-primary/15',
          )}
        >
          <RefreshCw className="h-4 w-4" />
          Réessayer
        </button>
      </CardContent>
    </Card>
  );
}

function GscSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" data-testid="gsc-skeleton">
      <div className="flex flex-wrap items-center gap-3">
        <div className="veridian-skeleton h-9 w-64 rounded-md" />
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
      <div className="space-y-2">
        <div className="veridian-skeleton h-9 w-full rounded" />
        <div className="veridian-skeleton h-9 w-full rounded" />
        <div className="veridian-skeleton h-9 w-full rounded" />
        <div className="veridian-skeleton h-9 w-full rounded" />
        <div className="veridian-skeleton h-9 w-full rounded" />
      </div>
    </div>
  );
}
