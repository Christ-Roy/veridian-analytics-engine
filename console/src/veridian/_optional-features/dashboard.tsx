import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { ServiceScoreBlock, type ServiceMetric } from './service-score-block';
import { ShadowMarketingBlock } from './shadow-marketing-block';
import { ImpersonationBanner } from '../impersonation-banner';
import { KNOWN_SERVICES, type ServiceKey } from '../types';
import { cn, formatNumber } from '../utils';
import {
  fetchDashboard,
  type DashboardPayload,
  type TenantStatusResponse,
  BridgeApiError,
} from '../api';
import { FormsTabStub } from './dashboard-tabs/forms-tab';
import { GscTabStub } from './dashboard-tabs/gsc-tab';
import { PushTabStub } from './dashboard-tabs/push-tab';
// Onglet "Appels" retiré : le code Calls custom (calls-tab) a été supprimé au
// port natif VoIP (ticket 2026-06-16). Les appels vivent dans Live/Explore
// natifs (events phone_call), plus dans un onglet dédié — cf voip-panel.tsx.
import { useContext } from 'react';
import { AuthContext } from '../../lib/AuthContext';
import { VeridianDemoComingSoon } from './demo-coming-soon';
import '../theme.css';

/**
 * VeridianDashboardPage — page root du dashboard Veridian intégrée dans la
 * console staminads. Affiche le Score Veridian global, l'état des services
 * actifs, et la "shadow marketing" pour les services à activer.
 *
 * Architecture :
 *   - Fetch parallèle des 3 endpoints bridge via `fetchDashboard()`
 *   - Suspension UI gérée à la main (pas de React.Suspense) pour skeleton
 *     custom + retry sur erreur sans déclencher le boundary global
 *   - Tout est scopé sous `<div className="veridian-scope">` pour ne pas
 *     polluer le thème AntDesign de la console
 *
 * Props :
 *   - `workspaceId` : id staminads du workspace (passé par la route TanStack)
 *   - `tenantName` / `tenantDomain` : metadata affichées dans le header
 *     (V1 : passées en prop par la route qui les a depuis `workspaceQueryOptions`)
 *   - `siteUrl` : URL externe du site client (bouton "Voir le site")
 *
 * État :
 *   - `loading` initial → skeleton shimmer plein
 *   - `error` → carte d'erreur avec CTA "Réessayer"
 *   - `data` → render complet : score hero + services actifs + shadow marketing
 */

export interface VeridianDashboardPageProps {
  workspaceId: string;
  tenantName?: string;
  tenantSlug?: string;
  tenantDomain?: string;
  siteUrl?: string;
  /**
   * Mode impersonation — pour un super-admin staminads qui inspecte le
   * dashboard d'un autre tenant. V1 = toujours false (sera branché en V2).
   */
  impersonating?: boolean;
  impersonatedTenantName?: string;
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: DashboardPayload };

type ActiveTab = 'overview' | 'forms' | 'gsc' | 'push';

export function VeridianDashboardPage({
  workspaceId,
  tenantName,
  tenantSlug,
  tenantDomain,
  siteUrl,
  impersonating = false,
  impersonatedTenantName,
}: VeridianDashboardPageProps) {
  // Read context directly so the component works even when rendered without
  // an AuthContext.Provider (legacy unit tests do that). useAuth() throws.
  const authCtx = useContext(AuthContext);
  const isDemo = authCtx?.isDemo ?? false;
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const [activeTab, setActiveTab] = useState<ActiveTab>('overview');
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    // Public demo: the veridian-bridge service that backs /api/admin/tenant/*
    // is intentionally NOT deployed on the demo compose (see compose/demo.yml).
    // The render path short-circuits to <VeridianDemoComingSoon /> below, but
    // we also skip the fetch here as a defense-in-depth so the AbortController
    // dance never fires in demo (would log a noisy network error in the
    // console of every prospect).
    if (isDemo) return;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });
    fetchDashboard(workspaceId, { signal: ctrl.signal })
      .then((data) => {
        if (!ctrl.signal.aborted) setState({ kind: 'ready', data });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        setState({ kind: 'error', error: err });
      });
  }, [workspaceId, isDemo]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  // Public demo: render a clean preview placeholder instead of "ERREUR 404
  // NOT FOUND" coming from the unavailable bridge admin endpoints (BUG-02).
  // Placed AFTER all hooks so the hook order is stable across renders.
  if (isDemo) {
    return (
      <VeridianDemoComingSoon
        tenantName={tenantName}
        tenantDomain={tenantDomain}
      />
    );
  }

  return (
    <div
      className="veridian-scope min-h-screen px-4 py-8 sm:px-6 lg:px-10"
      data-testid="veridian-dashboard-root"
    >
      <div className="mx-auto max-w-6xl space-y-8">
        {impersonating && impersonatedTenantName && tenantSlug && (
          <ImpersonationBanner
            tenantName={impersonatedTenantName}
            tenantSlug={tenantSlug}
          />
        )}

        <DashboardHeader
          tenantName={tenantName}
          tenantDomain={tenantDomain}
          siteUrl={siteUrl}
          state={state}
        />

        {state.kind === 'ready' && (
          <TabsBar activeTab={activeTab} onChange={setActiveTab} />
        )}

        {state.kind === 'loading' && <DashboardSkeleton />}

        {state.kind === 'error' && (
          <DashboardError error={state.error} onRetry={load} />
        )}

        {state.kind === 'ready' && activeTab === 'overview' && (
          <OverviewSection
            data={state.data}
            siteDomain={tenantDomain ?? `${workspaceId}.veridian.site`}
          />
        )}

        {state.kind === 'ready' && activeTab === 'forms' && (
          <FormsTabStub
            siteDomain={tenantDomain ?? `${workspaceId}.veridian.site`}
          />
        )}

        {state.kind === 'ready' && activeTab === 'gsc' && (
          <GscTabStub
            siteDomain={tenantDomain ?? `${workspaceId}.veridian.site`}
          />
        )}

        {state.kind === 'ready' && activeTab === 'push' && (
          <PushTabStub
            siteDomain={tenantDomain ?? `${workspaceId}.veridian.site`}
          />
        )}
      </div>
    </div>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────

function DashboardHeader({
  tenantName,
  tenantDomain,
  siteUrl,
  state,
}: {
  tenantName?: string;
  tenantDomain?: string;
  siteUrl?: string;
  state: ViewState;
}) {
  const tone =
    state.kind === 'ready'
      ? scoreTone(state.data.score.score)
      : { dot: 'bg-muted-foreground/40', label: '…' };

  return (
    <header
      className="veridian-fade-in flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between"
      data-testid="dashboard-header"
    >
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          <Sparkles className="h-3 w-3 text-primary" />
          Veridian Analytics
        </div>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          {tenantName ?? 'Mon dashboard'}
        </h1>
        {tenantDomain && (
          <p className="text-sm text-muted-foreground">
            <span
              className={cn('mr-2 inline-block h-1.5 w-1.5 rounded-full', tone.dot)}
              aria-hidden
            />
            {tenantDomain}
            <span className="mx-2 text-muted-foreground/40">•</span>
            <span className="text-muted-foreground/80">{tone.label}</span>
          </p>
        )}
      </div>
      {siteUrl && (
        <a
          href={siteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'inline-flex items-center gap-2 self-start rounded-lg border border-border/80 bg-card px-4 py-2 text-sm font-medium text-foreground',
            'transition-colors hover:border-primary/60 hover:text-primary',
          )}
          data-testid="visit-site-button"
        >
          Voir le site
          <ExternalLink className="h-4 w-4" />
        </a>
      )}
    </header>
  );
}

function scoreTone(score: number): { dot: string; label: string } {
  if (score >= 90) return { dot: 'bg-emerald-400', label: 'Excellent' };
  if (score >= 70) return { dot: 'bg-emerald-400/80', label: 'Très bon' };
  if (score >= 50) return { dot: 'bg-amber-400', label: 'Bon' };
  if (score >= 30) return { dot: 'bg-amber-500', label: 'À améliorer' };
  return { dot: 'bg-rose-400', label: 'À démarrer' };
}

// ─── Tabs ────────────────────────────────────────────────────────────────

function TabsBar({
  activeTab,
  onChange,
}: {
  activeTab: ActiveTab;
  onChange: (t: ActiveTab) => void;
}) {
  const tabs: Array<{ key: ActiveTab; label: string; soon?: boolean }> = [
    { key: 'overview', label: 'Vue d’ensemble' },
    { key: 'forms', label: 'Formulaires', soon: true },
    { key: 'gsc', label: 'Search Console', soon: true },
    { key: 'push', label: 'Notifications', soon: true },
  ];
  return (
    <div
      className="veridian-fade-in-delay-1 -mx-1 flex items-center gap-1 overflow-x-auto border-b border-border/60 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.key === activeTab;
        return (
          <button
            type="button"
            key={tab.key}
            role="tab"
            aria-selected={isActive}
            onClick={() => onChange(tab.key)}
            data-testid={`tab-${tab.key}`}
            className={cn(
              'group relative flex shrink-0 items-center gap-2 whitespace-nowrap px-4 py-2.5 text-sm font-medium transition-colors',
              isActive
                ? 'text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
            {tab.soon && (
              <span className="rounded-full bg-muted/50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/80">
                soon
              </span>
            )}
            <span
              className={cn(
                'absolute inset-x-3 -bottom-px h-px rounded-full transition-all',
                isActive
                  ? 'bg-primary opacity-100'
                  : 'bg-primary/0 opacity-0 group-hover:opacity-30',
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

// ─── Overview (vue d'ensemble : score hero + services actifs + shadow) ───

function OverviewSection({
  data,
  siteDomain,
}: {
  data: DashboardPayload;
  siteDomain: string;
}) {
  const { score, status } = data;

  // Tri canonique : actifs d'abord (dans l'ordre KNOWN_SERVICES), puis inactifs
  const ordered = useMemo(() => {
    const active = KNOWN_SERVICES.filter((s) =>
      status.activeServices.includes(s),
    );
    const inactive = KNOWN_SERVICES.filter(
      (s) => !status.activeServices.includes(s),
    );
    return { active, inactive };
  }, [status.activeServices]);

  return (
    <>
      <ScoreHero
        score={score.score}
        label={score.label}
        active={status.activeServices.length}
        total={KNOWN_SERVICES.length}
      />

      {ordered.active.length > 0 && (
        <Section
          title="Vos services actifs"
          subtitle="Performance des services Veridian connectés sur votre site"
          delay={2}
        >
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="active-services-grid"
          >
            {ordered.active.map((service, idx) => (
              <div
                key={service}
                className="veridian-fade-in"
                style={{ animationDelay: `${idx * 60 + 200}ms` }}
              >
                <ServiceScoreBlock
                  service={service}
                  metric={metricFor(service, status)}
                />
              </div>
            ))}
          </div>
        </Section>
      )}

      {ordered.inactive.length > 0 && (
        <Section
          title="Boostez vos résultats"
          subtitle="Activez les services Veridian pour mesurer plus de leviers et accélérer votre croissance"
          delay={3}
        >
          <div
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
            data-testid="shadow-marketing-grid"
          >
            {ordered.inactive.map((service, idx) => (
              <div
                key={service}
                className="veridian-fade-in"
                style={{ animationDelay: `${idx * 60 + 300}ms` }}
              >
                <ShadowMarketingBlock
                  service={service}
                  siteDomain={siteDomain}
                />
              </div>
            ))}
          </div>
        </Section>
      )}

      {ordered.active.length === 0 && (
        <EmptyStateInstallTracker siteDomain={siteDomain} />
      )}
    </>
  );
}

/**
 * Construit une `ServiceMetric` à partir des counts tenant-status pour un
 * service donné. V1 : pas de comparaison période précédente (deltaPct = 0
 * tant que B1/A4 ne fournissent pas les counts d'hier).
 *
 * Une sparkline placeholder est synthétisée pour les services actifs avec
 * count > 0 — c'est un "stub visuel" qui montre la donnée comme une courbe
 * légèrement croissante. Le vrai sparkline 30j arrivera avec un endpoint
 * `/api/admin/tenant/:id/timeseries` côté bridge (V2).
 */
function metricFor(
  service: ServiceKey,
  status: TenantStatusResponse,
): ServiceMetric {
  const valueMap: Record<ServiceKey, number> = {
    pageviews: status.counts.pageviews,
    forms: status.counts.forms,
    calls: status.counts.calls,
    gsc: status.counts.gscClicks,
    ads: 0,
    pagespeed: 0,
    push: 0,
  };
  const value = valueMap[service] ?? 0;
  // Sparkline synthétique : on simule une courbe quasi-linéaire qui aboutit
  // au count actuel. Pas idéal mais évite de laisser le slot vide pour V1.
  const sparkline =
    value > 0
      ? Array.from({ length: 14 }, (_, i) => ({
          day: `d-${13 - i}`,
          value: Math.max(
            1,
            Math.round((value / 14) * (i + 1) * (0.7 + Math.random() * 0.6)),
          ),
        }))
      : undefined;
  return { value, previous: 0, deltaPct: 0, sparkline };
}

// ─── Score hero ──────────────────────────────────────────────────────────

function ScoreHero({
  score,
  label,
  active,
  total,
}: {
  score: number;
  label: string;
  active: number;
  total: number;
}) {
  const tone = scoreToneFull(score);

  return (
    <Card className="veridian-fade-in-delay-1 relative overflow-hidden border-border/60 bg-card/80 backdrop-blur">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(ellipse at top right, hsl(174 72% 56% / 0.12), transparent 55%)',
        }}
        aria-hidden
      />
      <CardContent className="relative flex flex-col gap-8 p-8 sm:p-10 md:flex-row md:items-center md:justify-between">
        <div className="flex items-end gap-6">
          <div className="veridian-score-glow">
            <div
              data-testid="score-value"
              className={cn(
                'text-7xl font-semibold leading-none tabular-nums sm:text-8xl',
                tone.text,
              )}
            >
              {score}
            </div>
          </div>
          <div className="pb-3 space-y-2">
            <div className="text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Score Veridian
            </div>
            <div className={cn('text-xl font-semibold', tone.text)}>{label}</div>
            <div className="text-xs text-muted-foreground">
              <span
                className="font-medium text-foreground"
                data-testid="score-active-count"
              >
                {active}
              </span>
              {' / '}
              {total} services actifs
            </div>
          </div>
        </div>

        <div className="flex-1 md:max-w-sm space-y-3">
          <ScoreBar score={score} tone={tone} />
          <p className="text-xs leading-relaxed text-muted-foreground">
            Plus de services Veridian connectés = meilleure visibilité sur vos
            performances digitales. Activez les services en attente pour grimper
            jusqu’à 100.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ScoreBar({
  score,
  tone,
}: {
  score: number;
  tone: { bar: string };
}) {
  return (
    <div
      className="relative h-2 w-full overflow-hidden rounded-full bg-muted/40"
      role="progressbar"
      aria-valuenow={score}
      aria-valuemin={0}
      aria-valuemax={100}
      data-testid="score-bar"
    >
      <div
        className={cn(
          'h-full rounded-full transition-all duration-1000 ease-out',
          tone.bar,
        )}
        style={{ width: `${Math.max(2, score)}%` }}
      />
      <div
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          background:
            'linear-gradient(90deg, transparent 0%, hsl(0 0% 100% / 0.06) 50%, transparent 100%)',
        }}
      />
    </div>
  );
}

function scoreToneFull(score: number): { text: string; bar: string } {
  if (score >= 90)
    return { text: 'text-emerald-400', bar: 'bg-emerald-400' };
  if (score >= 70)
    return { text: 'text-emerald-300', bar: 'bg-emerald-300' };
  if (score >= 50)
    return { text: 'text-primary', bar: 'bg-primary' };
  if (score >= 30) return { text: 'text-amber-300', bar: 'bg-amber-300' };
  return { text: 'text-rose-300', bar: 'bg-rose-300' };
}

// ─── Section helper ──────────────────────────────────────────────────────

function Section({
  title,
  subtitle,
  delay,
  children,
}: {
  title: string;
  subtitle?: string;
  delay?: 1 | 2 | 3;
  children: React.ReactNode;
}) {
  const delayClass =
    delay === 3
      ? 'veridian-fade-in-delay-3'
      : delay === 2
        ? 'veridian-fade-in-delay-2'
        : delay === 1
          ? 'veridian-fade-in-delay-1'
          : 'veridian-fade-in';
  return (
    <section className={cn('space-y-4', delayClass)}>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        {subtitle && (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        )}
      </div>
      {children}
    </section>
  );
}

// ─── Skeleton (loading state) ────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div
      className="space-y-8"
      aria-busy="true"
      data-testid="dashboard-skeleton"
    >
      {/* Hero skeleton */}
      <div className="rounded-xl border border-border/60 bg-card/60 p-8 sm:p-10">
        <div className="flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
          <div className="flex items-end gap-6">
            <div className="veridian-skeleton h-20 w-28 rounded-lg" />
            <div className="space-y-3 pb-2">
              <div className="veridian-skeleton h-3 w-32 rounded" />
              <div className="veridian-skeleton h-5 w-24 rounded" />
              <div className="veridian-skeleton h-3 w-40 rounded" />
            </div>
          </div>
          <div className="flex-1 space-y-3 md:max-w-sm">
            <div className="veridian-skeleton h-2 w-full rounded-full" />
            <div className="veridian-skeleton h-3 w-3/4 rounded" />
            <div className="veridian-skeleton h-3 w-2/3 rounded" />
          </div>
        </div>
      </div>

      {/* Grid skeleton */}
      <div className="space-y-4">
        <div className="veridian-skeleton h-4 w-48 rounded" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-44 rounded-xl border border-border/60 bg-card/60 p-6"
            >
              <div className="veridian-skeleton h-5 w-24 rounded" />
              <div className="mt-4 flex items-baseline justify-between">
                <div className="veridian-skeleton h-8 w-20 rounded" />
                <div className="veridian-skeleton h-3 w-10 rounded" />
              </div>
              <div className="veridian-skeleton mt-6 h-10 w-full rounded" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Error state ─────────────────────────────────────────────────────────

function DashboardError({
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
      ? "Votre session n'a pas les droits pour consulter ce dashboard. Reconnectez-vous ou contactez Robert pour vérifier vos accès."
      : status === 404
        ? "Ce workspace n'a pas encore été provisionné côté analytics. Lancez l'installation du tracker pour démarrer."
        : status && status >= 500
          ? 'Le service analytics est temporairement indisponible. Réessayez dans quelques instants.'
          : "Impossible de joindre le service analytics. Vérifiez votre connexion réseau et réessayez.";

  return (
    <Card
      className="veridian-fade-in border-border/60 bg-card/80"
      data-testid="dashboard-error"
    >
      <CardContent className="flex flex-col items-center gap-6 py-12 text-center sm:py-16">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <div className="space-y-2 max-w-md">
          <h2 className="text-xl font-semibold">Données indisponibles</h2>
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
          data-testid="retry-button"
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

// ─── Empty state (workspace vide, jamais d'event reçu) ───────────────────

function EmptyStateInstallTracker({ siteDomain }: { siteDomain: string }) {
  const installUrl = `mailto:contact@veridian.site?subject=${encodeURIComponent(
    'Veridian Analytics — installer le tracker',
  )}&body=${encodeURIComponent(
    `Bonjour Robert,\n\nJe souhaite installer le tracker Veridian sur ${siteDomain}.\nMerci de m'envoyer le snippet à coller.\n\n--\nEnvoyé depuis mon dashboard Veridian`,
  )}`;
  return (
    <Card
      className="veridian-fade-in-delay-2 border-dashed border-border/60 bg-card/60"
      data-testid="empty-install-tracker"
    >
      <CardContent className="flex flex-col items-center gap-6 py-14 text-center">
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <CheckCircle2 className="h-8 w-8" />
          <span className="absolute inset-0 rounded-full veridian-pulse-ring" />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-xl font-semibold">Votre dashboard est prêt</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Aucune donnée n’a encore été reçue pour {siteDomain}. Installez le
            snippet Veridian sur votre site pour commencer à voir vos visiteurs
            apparaître ici en temps réel.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <a
            href={installUrl}
            className={cn(
              'inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground',
              'transition-transform hover:scale-[1.02]',
            )}
          >
            Installer le tracker
            <ArrowUpRight className="h-4 w-4" />
          </a>
          <a
            href="https://docs.veridian.site/analytics"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-border/70 px-5 py-2.5 text-sm font-medium text-muted-foreground hover:border-primary/40 hover:text-foreground transition-colors"
          >
            Lire la doc
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          {formatNumber(0)} visites enregistrées pour l’instant — ça va changer
          très vite.
        </p>
      </CardContent>
    </Card>
  );
}
