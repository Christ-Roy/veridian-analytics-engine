import { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Phone,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Play,
  RefreshCw,
  Settings2,
} from 'lucide-react';
import { Card, CardContent } from '../../ui/card';
import { Badge } from '../../ui/badge';
import { cn, formatNumber } from '../../utils';
import { BridgeApiError, type CallRecord, type CallsResponse } from '../../api';
import { formatCallDate, formatDuration } from './calls-hooks';

/**
 * Composants de présentation du tab Calls (ticket U9).
 *
 * Extraits de `calls-tab.tsx` pour garder l'orchestrateur sous la limite
 * mégafichier (500 lignes) de la CI Veridian. Aucune logique de fetch ici :
 * tout est piloté par props depuis `CallsTab` / le hook `useCalls`.
 */

// ─── Ready : stats + graphe + table ──────────────────────────────────────

export function CallsReady({
  data,
  days,
}: {
  data: CallsResponse;
  days: number;
}) {
  if (data.calls.length === 0) {
    return <CallsEmpty days={days} />;
  }
  return (
    <>
      <CallsStats stats={data.stats} days={days} />
      <CallsDailyChart daily={data.daily} />
      <CallsTable calls={data.calls} />
    </>
  );
}

// ─── Stats bandeau ───────────────────────────────────────────────────────

function CallsStats({
  stats,
  days,
}: {
  stats: CallsResponse['stats'];
  days: number;
}) {
  const answerRatePct = Math.round(stats.answerRate * 100);
  const cards: Array<{
    label: string;
    value: string;
    hint: string;
    tone: 'neutral' | 'good' | 'warn';
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    {
      label: 'Appels reçus',
      value: formatNumber(stats.total),
      hint: `sur ${days} jours`,
      tone: 'neutral',
      icon: Phone,
    },
    {
      label: 'Appels manqués',
      value: formatNumber(stats.missed),
      hint:
        stats.missed > 0
          ? 'autant de clients à rappeler'
          : 'aucun appel raté 🎉',
      tone: stats.missed > 0 ? 'warn' : 'good',
      icon: PhoneMissed,
    },
    {
      label: 'Durée moyenne',
      value: formatDuration(stats.avgDurationSec),
      hint: 'des appels décrochés',
      tone: 'neutral',
      icon: PhoneIncoming,
    },
    {
      label: 'Taux de réponse',
      value: `${answerRatePct}%`,
      hint:
        answerRatePct >= 80
          ? 'excellent'
          : answerRatePct >= 60
            ? 'correct'
            : 'à améliorer',
      tone:
        answerRatePct >= 80 ? 'good' : answerRatePct >= 60 ? 'neutral' : 'warn',
      icon: ArrowUpRight,
    },
  ];

  return (
    <div
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      data-testid="calls-stats"
    >
      {cards.map((c) => {
        const Icon = c.icon;
        const toneText =
          c.tone === 'good'
            ? 'text-emerald-400'
            : c.tone === 'warn'
              ? 'text-amber-400'
              : 'text-foreground';
        return (
          <Card key={c.label} className="border-border/60 bg-card/80">
            <CardContent className="space-y-3 p-5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  {c.label}
                </span>
                <Icon className="h-4 w-4 text-muted-foreground/60" />
              </div>
              <div
                className={cn(
                  'text-3xl font-semibold tabular-nums',
                  toneText,
                )}
              >
                {c.value}
              </div>
              <div className="text-[11px] text-muted-foreground/70">
                {c.hint}
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ─── Graphe appels par jour ──────────────────────────────────────────────

function CallsDailyChart({ daily }: { daily: CallsResponse['daily'] }) {
  const max = useMemo(
    () => Math.max(1, ...daily.map((d) => d.total)),
    [daily],
  );

  if (daily.length === 0) return null;

  return (
    <Card
      className="border-border/60 bg-card/80"
      data-testid="calls-daily-chart"
    >
      <CardContent className="space-y-4 p-6">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-foreground">
            Appels par jour
          </h3>
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-wider text-muted-foreground/70">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-primary/70" />
              décrochés
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-amber-400/80" />
              manqués
            </span>
          </div>
        </div>
        <div
          className="flex h-32 items-end gap-1"
          role="img"
          aria-label="Histogramme des appels par jour"
        >
          {daily.map((d) => {
            const totalH = (d.total / max) * 100;
            const missedH = (d.missed / max) * 100;
            return (
              <div
                key={d.day}
                className="group relative flex flex-1 flex-col justify-end"
                title={`${d.day} — ${d.total} appel(s), ${d.missed} manqué(s)`}
              >
                <div
                  className="w-full rounded-sm bg-primary/60 transition-colors group-hover:bg-primary"
                  style={{ height: `${Math.max(2, totalH)}%` }}
                >
                  {d.missed > 0 && (
                    <div
                      className="w-full rounded-sm bg-amber-400/80"
                      style={{
                        height: `${Math.min(100, (missedH / Math.max(totalH, 0.01)) * 100)}%`,
                      }}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Table des appels ────────────────────────────────────────────────────

function CallsTable({ calls }: { calls: CallRecord[] }) {
  return (
    <Card className="border-border/60 bg-card/80" data-testid="calls-table">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground/70">
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Sens</th>
                <th className="px-5 py-3 font-medium">Numéro</th>
                <th className="px-5 py-3 font-medium">Durée</th>
                <th className="px-5 py-3 font-medium">Statut</th>
                <th className="px-5 py-3 font-medium">Enregistrement</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((call) => (
                <CallRow key={call.id} call={call} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function CallRow({ call }: { call: CallRecord }) {
  const isInbound = call.direction === 'inbound';
  return (
    <tr
      className="border-b border-border/40 last:border-0 transition-colors hover:bg-accent/40"
      data-testid="call-row"
    >
      <td className="whitespace-nowrap px-5 py-3 text-muted-foreground">
        {formatCallDate(call.startedAt)}
      </td>
      <td className="px-5 py-3">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-xs font-medium',
            isInbound ? 'text-emerald-400' : 'text-sky-400',
          )}
        >
          {isInbound ? (
            <ArrowDownLeft className="h-3.5 w-3.5" />
          ) : (
            <PhoneOutgoing className="h-3.5 w-3.5" />
          )}
          {isInbound ? 'Entrant' : 'Sortant'}
        </span>
      </td>
      <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-foreground">
        {call.peerNumber}
      </td>
      <td className="whitespace-nowrap px-5 py-3 tabular-nums text-muted-foreground">
        {call.status === 'answered' ? formatDuration(call.durationSec) : '—'}
      </td>
      <td className="px-5 py-3">
        <CallStatusBadge status={call.status} />
      </td>
      <td className="px-5 py-3">
        {call.recordingUrl ? (
          <a
            href={call.recordingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            data-testid="call-recording-link"
          >
            <Play className="h-3.5 w-3.5" />
            Écouter
          </a>
        ) : (
          <span className="text-xs text-muted-foreground/50">—</span>
        )}
      </td>
    </tr>
  );
}

function CallStatusBadge({ status }: { status: CallRecord['status'] }) {
  const map: Record<
    CallRecord['status'],
    {
      label: string;
      variant: 'success' | 'warning' | 'destructive' | 'secondary';
    }
  > = {
    answered: { label: 'Répondu', variant: 'success' },
    missed: { label: 'Manqué', variant: 'warning' },
    busy: { label: 'Occupé', variant: 'secondary' },
    failed: { label: 'Échec', variant: 'destructive' },
  };
  const cfg = map[status] ?? map.failed;
  return (
    <Badge variant={cfg.variant} className="text-[10px]">
      {cfg.label}
    </Badge>
  );
}

// ─── État : téléphonie non branchée (inclut 404 B-VOIP pas livré) ────────

export function CallsNotConnected({
  siteDomain,
  onOpenSettings,
}: {
  siteDomain: string;
  onOpenSettings?: () => void;
}) {
  const mailto = `mailto:contact@veridian.site?subject=${encodeURIComponent(
    'Veridian Analytics — activer le call tracking',
  )}&body=${encodeURIComponent(
    `Bonjour Robert,\n\nJe souhaite activer le suivi des appels téléphoniques pour ${siteDomain}.\nMerci de me proposer un numéro dédié et de m'indiquer le coût mensuel.\n\n--\nEnvoyé depuis mon dashboard Veridian`,
  )}`;

  return (
    <Card
      className="veridian-fade-in border-dashed border-border/60 bg-card/60"
      data-testid="calls-not-connected"
    >
      <CardContent className="flex flex-col items-center gap-6 py-14 text-center">
        <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Phone className="h-8 w-8" />
          <span className="absolute inset-0 rounded-full veridian-pulse-ring" />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-xl font-semibold">Connectez votre téléphonie</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Chaque appel manqué est un client perdu. Branchez un numéro dédié
            Veridian pour voir d'où viennent vos appels, combien vous en
            ratez, et quelles pages de votre site génèrent le plus de
            contacts — le tout ici, dans votre dashboard.
          </p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          {onOpenSettings ? (
            <button
              type="button"
              onClick={onOpenSettings}
              data-testid="calls-cta-settings"
              className={cn(
                'inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground',
                'transition-transform hover:scale-[1.02]',
              )}
            >
              <Settings2 className="h-4 w-4" />
              Configurer la téléphonie
            </button>
          ) : (
            <a
              href={mailto}
              data-testid="calls-cta-mailto"
              className={cn(
                'inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground',
                'transition-transform hover:scale-[1.02]',
              )}
            >
              Activer le call tracking
              <ArrowUpRight className="h-4 w-4" />
            </a>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          Numéro dédié à partir de 15 €/mois — sans engagement.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── État : VoIP branché mais 0 appel ────────────────────────────────────

function CallsEmpty({ days }: { days: number }) {
  return (
    <Card
      className="veridian-fade-in border-dashed border-border/60 bg-card/60"
      data-testid="calls-empty"
    >
      <CardContent className="flex flex-col items-center gap-5 py-14 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10 text-primary">
          <PhoneIncoming className="h-7 w-7" />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-lg font-semibold">Aucun appel pour l'instant</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Votre téléphonie est bien connectée, mais aucun appel n'a été
            enregistré sur les {days} derniers jours. Dès qu'un client vous
            appelle, l'appel apparaîtra ici automatiquement.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── État : erreur ───────────────────────────────────────────────────────

export function CallsError({
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
      ? "Votre session n'a pas les droits pour consulter les appels. Reconnectez-vous ou contactez Robert."
      : status && status >= 500
        ? 'Le service de téléphonie est temporairement indisponible. Réessayez dans quelques instants.'
        : 'Impossible de charger vos appels. Vérifiez votre connexion et réessayez.';

  return (
    <Card
      className="veridian-fade-in border-border/60 bg-card/80"
      data-testid="calls-error"
    >
      <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <div className="max-w-md space-y-2">
          <h2 className="text-xl font-semibold">Appels indisponibles</h2>
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
          data-testid="calls-retry-button"
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

// ─── État : skeleton (loading) ───────────────────────────────────────────

export function CallsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" data-testid="calls-skeleton">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-xl border border-border/60 bg-card/60 p-5"
          >
            <div className="veridian-skeleton h-3 w-24 rounded" />
            <div className="veridian-skeleton mt-4 h-8 w-20 rounded" />
            <div className="veridian-skeleton mt-3 h-3 w-28 rounded" />
          </div>
        ))}
      </div>
      <div className="rounded-xl border border-border/60 bg-card/60 p-6">
        <div className="veridian-skeleton h-4 w-32 rounded" />
        <div className="veridian-skeleton mt-4 h-32 w-full rounded" />
      </div>
      <div className="rounded-xl border border-border/60 bg-card/60 p-6">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="veridian-skeleton h-9 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
