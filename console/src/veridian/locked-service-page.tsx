import {
  Lock,
  Phone,
  Inbox,
  LineChart,
  Search,
  Megaphone,
  Gauge,
  Bell,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react';
import { Card, CardContent } from './ui/card';
import type { ServiceKey, ShadowIconKey } from './types';
import { SHADOW_MARKETING, buildMailto } from './types';
import { cn } from './utils';

/**
 * LockedServicePage : écran plein affiché sur les pages dont le service est
 * inactif pour le tenant courant. Cohérent visuellement avec
 * ShadowMarketingBlock (même palette mutée, même CTA mailto).
 *
 * L'idée : quand un client arrive sur /dashboard/calls et qu'il n'a pas
 * encore activé le call tracking, il voit un CTA vendeur pour activer le
 * service. La page basculera automatiquement vers le vrai dashboard dès
 * que la première donnée arrivera (reload côté page consommatrice).
 */

const ICON_MAP: Record<ShadowIconKey, React.ComponentType<{ className?: string }>> = {
  phone: Phone,
  inbox: Inbox,
  'line-chart': LineChart,
  search: Search,
  megaphone: Megaphone,
  gauge: Gauge,
  bell: Bell,
};

const LOCKED_TITLE: Record<ServiceKey, string> = {
  pageviews: 'Tracking site verrouille',
  forms: 'Suivi des formulaires verrouille',
  calls: 'Appels telephoniques verrouilles',
  gsc: 'Google Search Console verrouille',
  ads: 'Suivi Google Ads verrouille',
  pagespeed: 'Monitoring PageSpeed verrouille',
  push: 'Notifications push verroullees',
};

export function LockedServicePage({
  service,
  siteDomain,
}: {
  service: ServiceKey;
  /**
   * Domaine du site du client — utilisé pour pré-remplir le body de l'email.
   * Si le tenant n'a pas de site (edge case), passer une chaîne vide et
   * le body d'email sera générique.
   */
  siteDomain: string;
}) {
  const entry = SHADOW_MARKETING[service];
  const Icon = ICON_MAP[entry.icon];
  const mailto = buildMailto(service, siteDomain || 'votre-site.fr');
  const title = LOCKED_TITLE[service];

  return (
    <div
      className="flex min-h-[60vh] items-center justify-center"
      data-testid={`locked-page-${service}`}
      data-service={service}
    >
      <Card
        className={cn(
          'w-full max-w-2xl border-dashed border-border/60 bg-muted/20',
        )}
      >
        <CardContent className="flex flex-col items-center gap-6 py-12 text-center">
          <div className="relative">
            <div className="flex h-20 w-20 items-center justify-center rounded-full bg-muted/40 text-muted-foreground/70">
              <Lock className="h-10 w-10" />
            </div>
            <div className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border border-border/60 bg-background text-muted-foreground">
              <Icon className="h-4 w-4" />
            </div>
          </div>

          <div className="space-y-2">
            <h1
              className="text-2xl font-semibold text-muted-foreground"
              data-testid="locked-title"
            >
              {title}
            </h1>
            <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground/80">
              {entry.description}
            </p>
          </div>

          <a
            href={mailto}
            data-testid="locked-cta"
            className={cn(
              'inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/5 px-5 py-2.5 text-sm font-medium text-primary',
              'transition-colors hover:border-primary/70 hover:bg-primary/10',
            )}
          >
            {entry.ctaLabel}
            <ArrowUpRight className="h-4 w-4" />
          </a>

          <div className="flex items-center gap-2 rounded-md border border-border/40 bg-muted/10 px-4 py-2 text-[11px] text-muted-foreground/70">
            <RefreshCw className="h-3 w-3" />
            <span>
              Des que ce service sera active, cette page s&apos;ouvrira
              automatiquement au prochain reload.
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
