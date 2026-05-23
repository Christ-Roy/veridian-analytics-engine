import {
  ArrowUpRight,
  TrendingDown,
  TrendingUp,
  Phone,
  Inbox,
  LineChart,
  Search,
  Bell,
  CheckCircle2,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Sparkline } from '../sparkline';
import type { ServiceKey } from '../types';
import { cn, formatNumber, formatPercent } from '../utils';

/**
 * ServiceScoreBlock : carte "active" affichant une metric et sa tendance
 * pour un service que le client a déjà branché. Badge vert discret "Actif"
 * en coin, icône du service, sparkline en bas.
 *
 * Complémente ShadowMarketingBlock dans la grille d'accueil du dashboard :
 * chaque service est soit "actif" (ce composant), soit "à activer" (shadow).
 *
 * Composant présentationnel : reçoit `metric` en prop, ne fetch rien. Le
 * fetch sera fait dans les pages (ticket C2).
 */

const SERVICE_META: Record<
  ServiceKey,
  {
    label: string;
    metricLabel: string;
    icon: React.ComponentType<{ className?: string }>;
    href: string;
  }
> = {
  pageviews: {
    label: 'Pages vues',
    metricLabel: 'visites 28j',
    icon: LineChart,
    href: '/dashboard',
  },
  forms: {
    label: 'Formulaires',
    metricLabel: 'leads 28j',
    icon: Inbox,
    href: '/dashboard/forms',
  },
  calls: {
    label: 'Appels',
    metricLabel: 'appels 28j',
    icon: Phone,
    href: '/dashboard/calls',
  },
  gsc: {
    label: 'Google Search Console',
    metricLabel: 'clics 28j',
    icon: Search,
    href: '/dashboard/gsc',
  },
  ads: {
    label: 'Google Ads',
    metricLabel: 'conversions 28j',
    icon: LineChart,
    href: '/dashboard',
  },
  pagespeed: {
    label: 'PageSpeed',
    metricLabel: 'score moyen',
    icon: LineChart,
    href: '/dashboard',
  },
  push: {
    label: 'Notifications',
    metricLabel: 'abonnes',
    icon: Bell,
    href: '/dashboard/push',
  },
};

export interface ServiceMetric {
  value: number;
  previous: number;
  deltaPct: number;
  sparkline?: Array<{ day: string; value: number }>;
}

export function ServiceScoreBlock({
  service,
  metric,
  className,
  href,
}: {
  service: ServiceKey;
  metric: ServiceMetric;
  className?: string;
  /** Override the default href (defaults to SERVICE_META[service].href) */
  href?: string;
}) {
  const meta = SERVICE_META[service];
  const Icon = meta.icon;
  const positive = metric.deltaPct >= 0;
  const TrendIcon = positive ? TrendingUp : TrendingDown;

  return (
    <a
      href={href ?? meta.href}
      className={cn('group block', className)}
      data-testid={`service-${service}`}
      data-service={service}
    >
      <Card
        className={cn(
          'relative h-full transition-colors',
          'hover:border-primary/50',
          positive ? 'hover:border-emerald-400/50' : 'hover:border-rose-400/50',
        )}
      >
        <div
          className="absolute right-3 top-3 flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500"
          aria-label="Service actif"
        >
          <CheckCircle2 className="h-3 w-3" />
          Actif
        </div>

        <CardContent className="flex h-full flex-col gap-3 pt-6">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {meta.label}
            </span>
          </div>

          <div className="flex items-baseline justify-between gap-4">
            <div
              className="text-3xl font-semibold tabular-nums"
              data-testid={`service-${service}-value`}
            >
              {formatNumber(metric.value)}
            </div>
            <div
              className={cn(
                'flex items-center gap-1 text-xs font-medium',
                positive ? 'text-emerald-500' : 'text-rose-500',
              )}
              data-testid={`service-${service}-delta`}
            >
              <TrendIcon className="h-3 w-3" />
              {formatPercent(metric.deltaPct, 1)}
            </div>
          </div>

          {metric.sparkline && metric.sparkline.length > 0 && (
            <div className="-mx-2 flex-1">
              <Sparkline
                data={metric.sparkline}
                positive={positive}
                height={40}
              />
            </div>
          )}

          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
            <span>{meta.metricLabel}</span>
            <ArrowUpRight className="h-3 w-3 transition-colors group-hover:text-primary" />
          </div>
        </CardContent>
      </Card>
    </a>
  );
}
