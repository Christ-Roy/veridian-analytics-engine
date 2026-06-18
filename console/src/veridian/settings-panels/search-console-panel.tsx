import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Empty,
  Select,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { Search } from 'lucide-react';
import { BridgeApiError } from '../api';
import {
  fetchGscDashboard,
  fetchGscStatus,
  fetchGscOauthBeginUrl,
  triggerGscResync,
  disconnectGsc,
  type GscStatusResponse,
} from '../gsc/api';
import { KpiTile } from '../gsc/kpi-tile';
import { TimeSeriesChart } from '../gsc/time-series-chart';
import { GscDataTable } from '../gsc/data-table';
import {
  DATE_RANGES,
  DIMENSION_META,
  type GscDashboardResponse,
  type MetricKey,
} from '../gsc/types';

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
 * Rendu Ant Design natif (fond clair, primaire violet `#7763F1`), cohérent avec
 * les autres panels Settings (TeamSettings / AnnotationsSettings / api-keys).
 * La logique métier (OAuth connect, sync, disconnect, fetch dashboard) est
 * inchangée — seule la couche de présentation est en AntD.
 */

export interface SearchConsoleSettingsPanelProps {
  workspaceId: string;
  /** Domaine du site (fallback `{workspaceId}.veridian.site`). */
  siteDomain?: string;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; gsc: GscStatusResponse };

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
    fetchGscStatus(workspaceId, { signal: ctrl.signal })
      .then((gsc) => {
        if (!ctrl.signal.aborted) setState({ kind: 'ready', gsc });
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
    <div className="w-full" data-testid="search-console-settings-panel">
      <Space direction="vertical" size="large" className="w-full">
        {state.kind === 'loading' && <PanelSkeleton />}
        {state.kind === 'error' && (
          <PanelError error={state.error} onRetry={load} />
        )}
        {state.kind === 'ready' && (
          <>
            <GscConnectionSection
              workspaceId={workspaceId}
              gsc={state.gsc}
              onRefresh={load}
            />
            {state.gsc.connected && (
              <GscInlineData
                workspaceId={workspaceId}
                siteDomain={
                  siteDomain ??
                  state.gsc.site_url ??
                  `${workspaceId}.veridian.site`
                }
              />
            )}
          </>
        )}
      </Space>
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
  gsc: GscStatusResponse;
  onRefresh: () => void;
}) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState<null | 'connect' | 'resync' | 'disconnect'>(
    null,
  );

  const connect = useCallback(async () => {
    setBusy('connect');
    try {
      const url = await fetchGscOauthBeginUrl(workspaceId);
      window.location.href = url;
    } catch (err) {
      message.error(
        err instanceof BridgeApiError
          ? err.message
          : 'Impossible de démarrer la connexion Search Console.',
      );
      setBusy(null);
    }
  }, [workspaceId, message]);

  const resync = useCallback(async () => {
    setBusy('resync');
    try {
      await triggerGscResync(workspaceId);
      message.success('Resynchronisation lancée.');
      onRefresh();
    } catch (err) {
      message.error(
        err instanceof BridgeApiError
          ? err.message
          : 'Resynchronisation impossible.',
      );
    } finally {
      setBusy(null);
    }
  }, [workspaceId, onRefresh, message]);

  const disconnect = useCallback(async () => {
    setBusy('disconnect');
    try {
      await disconnectGsc(workspaceId);
      message.success('Search Console déconnectée.');
      onRefresh();
    } catch (err) {
      message.error(
        err instanceof BridgeApiError
          ? err.message
          : 'Déconnexion impossible.',
      );
    } finally {
      setBusy(null);
    }
  }, [workspaceId, onRefresh, message]);

  return (
    <Section
      icon={Search}
      title="Google Search Console"
      description="Connectez votre Search Console pour suivre vos requêtes, vos positions Google et repérer les pages qui montent."
      testId="settings-section-gsc"
    >
      {gsc.connected ? (
        <div data-testid="gsc-connected">
          <Space size="small" wrap>
            <Tag color="success">Connecté</Tag>
            {gsc.site_url && (
              <Typography.Text type="secondary">
                {gsc.site_url}
              </Typography.Text>
            )}
          </Space>
          <Typography.Paragraph
            type="secondary"
            className="!mt-2 !mb-0 text-xs"
          >
            Dernière synchro :{' '}
            {gsc.last_sync_at ? formatDate(gsc.last_sync_at) : 'jamais'}
          </Typography.Paragraph>
          <Space className="mt-4" wrap>
            <Button
              icon={<ReloadOutlined />}
              onClick={resync}
              loading={busy === 'resync'}
              disabled={busy !== null}
              data-testid="gsc-resync-btn"
            >
              Resynchroniser maintenant
            </Button>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              onClick={disconnect}
              loading={busy === 'disconnect'}
              disabled={busy !== null}
              data-testid="gsc-disconnect-btn"
            >
              Déconnecter
            </Button>
          </Space>
        </div>
      ) : (
        <div data-testid="gsc-disconnected">
          <Space direction="vertical" size="middle" className="w-full">
            <Typography.Text type="secondary">
              Veridian lira votre Search Console en lecture seule. Vous n'avez
              pas de clé à saisir — il suffit d'autoriser l'accès via votre
              compte Google.
            </Typography.Text>
            <Button
              type="primary"
              onClick={connect}
              loading={busy === 'connect'}
              disabled={busy !== null}
              data-testid="gsc-connect-btn"
            >
              Connecter Search Console
            </Button>
          </Space>
        </div>
      )}
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
      <Card data-testid="gsc-inline-not-ready">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <Typography.Text type="secondary">
              Vos données Search Console sont en cours de première
              synchronisation pour {siteDomain}. Revenez dans quelques minutes
              ou cliquez sur « Resynchroniser maintenant » ci-dessus.
            </Typography.Text>
          }
        />
      </Card>
    );
  }
  if (state.kind === 'error') {
    return (
      <Card data-testid="gsc-inline-error">
        <Alert
          type="error"
          showIcon
          message="Search Console indisponible"
          description={state.error.message}
        />
        <Button
          icon={<ReloadOutlined />}
          onClick={load}
          className="mt-4"
          size="small"
        >
          Réessayer
        </Button>
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
    <Card data-testid="gsc-inline-data" styles={{ body: { padding: 24 } }}>
      <Space direction="vertical" size="large" className="w-full">
        {/* Sélecteur de fenêtre */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <Typography.Title level={5} className="!mb-0.5">
              Performances Search Console
            </Typography.Title>
            <Typography.Text type="secondary" className="text-xs">
              Propriété : {data.property?.siteUrl ?? siteDomain}
            </Typography.Text>
          </div>
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
    <div
      className="bg-white p-6 rounded-lg shadow-sm"
      data-testid={testId}
    >
      <div className="flex items-start gap-3 mb-5">
        <Icon className="h-5 w-5 mt-1 shrink-0 text-[#7763F1]" />
        <div>
          <Typography.Title level={4} className="!mb-0.5">
            {title}
          </Typography.Title>
          {description && (
            <Typography.Text type="secondary">{description}</Typography.Text>
          )}
        </div>
      </div>
      <div>{children}</div>
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div data-testid="gsc-panel-skeleton">
      <Space direction="vertical" size="large" className="w-full">
        {[0, 1].map((i) => (
          <div key={i} className="bg-white p-6 rounded-lg shadow-sm">
            <Skeleton active paragraph={{ rows: 3 }} />
          </div>
        ))}
      </Space>
    </div>
  );
}

function InlineSkeleton() {
  return (
    <Card>
      <Skeleton active paragraph={{ rows: 6 }} />
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
    <div
      className="bg-white p-6 rounded-lg shadow-sm"
      data-testid="gsc-panel-error"
    >
      <Alert
        type="error"
        showIcon
        message="Impossible de charger les paramètres Search Console"
        description={error.message}
      />
      <Button
        icon={<ReloadOutlined />}
        onClick={onRetry}
        className="mt-4"
        size="small"
      >
        Réessayer
      </Button>
    </div>
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
