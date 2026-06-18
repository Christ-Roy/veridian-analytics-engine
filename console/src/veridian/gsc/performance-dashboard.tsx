import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, Select, Skeleton, Space, Tabs, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Search } from 'lucide-react';
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
 * Vue principale Search Console — composant orchestrateur (standalone).
 *
 * NOTE : ce composant n'est plus monté dans l'UI live (le panel Settings
 * `search-console-panel.tsx` embarque sa propre version inline `GscInlineData`).
 * Il est conservé harmonisé en Ant Design natif (fond clair, primaire violet)
 * pour ne pas réintroduire un îlot sombre dans le module `gsc/`.
 *
 * Consomme `GET /api/gsc/dashboard?days=N` du module natif engine. Le backend
 * fait déjà le boulot lourd : agrégation server-side, top 50 mots-clés/pages,
 * série temporelle.
 *
 * États gérés :
 *   - `loading` initial         → skeleton
 *   - `not-connected`           → onboarding « Connectez votre GSC »
 *   - `error`                   → carte d'erreur + bouton Réessayer
 *   - `ready` (data)            → vue complète : KPIs + chart + tabs query/page
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
        // 404 du backend → endpoint pas encore livré sur cet env → onboarding propre
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
    <div data-testid="gsc-dashboard">
      <Space direction="vertical" size="large" className="w-full">
        {/* Header : property + range selector */}
        <div className="flex flex-wrap items-center gap-3">
          <Space
            size="small"
            className="rounded-md border border-gray-200 bg-white px-3 py-1.5"
            data-testid="gsc-property"
          >
            <Search className="h-3.5 w-3.5 text-[#7763F1]" />
            <Typography.Text strong className="text-xs">
              {data.property?.siteUrl}
            </Typography.Text>
          </Space>
          <Select
            value={rangeKey}
            onChange={(v) => setRangeKey(v)}
            data-testid="gsc-range-selector"
            style={{ minWidth: 180 }}
            options={DATE_RANGES.map((r) => ({
              value: r.value,
              label: r.label,
            }))}
          />
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

        {/* Onglets dimensions : query / page + data-table */}
        <Tabs
          activeKey={activeTab}
          onChange={(k) => setActiveTab(k as Tab)}
          items={(['query', 'page'] as Tab[]).map((d) => ({
            key: d,
            label: (
              <span data-testid={`gsc-tab-${d}`}>
                <span className="mr-1">{DIMENSION_META[d].icon}</span>
                {DIMENSION_META[d].label}
              </span>
            ),
            children: (
              <GscDataTable
                rows={d === 'query' ? data.topQueries : data.topPages}
                dimensionLabel={DIMENSION_META[d].label}
              />
            ),
          }))}
        />
      </Space>
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
    <Card data-testid="gsc-not-connected">
      <div className="flex flex-col items-center gap-6 py-10 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-[#7763F1]/10 text-[#7763F1]">
          <Search className="h-8 w-8" />
        </div>
        <div className="max-w-md">
          <Typography.Title level={4}>
            Connectez votre Search Console
          </Typography.Title>
          <Typography.Paragraph type="secondary">
            Découvrez sur quels mots-clés Google vous trouve, repérez les pages
            qui montent et celles qui décrochent. Une fois branchée, votre
            Search Console se synchronise toutes les nuits — vos données
            apparaîtront ici sans aller fouiller dans l'interface Google.
          </Typography.Paragraph>
        </div>
        <Button type="primary" href={mailto} data-testid="gsc-cta-mailto">
          Connecter ma Search Console
        </Button>
      </div>
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
    <Card data-testid="gsc-error">
      <Alert
        type="warning"
        showIcon
        message="Search Console indisponible"
        description={
          <>
            <Typography.Paragraph type="secondary" className="!mb-1">
              {friendly}
            </Typography.Paragraph>
            {status && (
              <Typography.Text
                type="secondary"
                className="text-[10px] uppercase tracking-wider"
              >
                Erreur {status} · {error.message}
              </Typography.Text>
            )}
          </>
        }
      />
      <Button
        icon={<ReloadOutlined />}
        onClick={onRetry}
        className="mt-4"
        size="small"
        data-testid="gsc-retry-button"
      >
        Réessayer
      </Button>
    </Card>
  );
}

function GscSkeleton() {
  return (
    <Card aria-busy="true" data-testid="gsc-skeleton">
      <Skeleton active paragraph={{ rows: 8 }} />
    </Card>
  );
}
