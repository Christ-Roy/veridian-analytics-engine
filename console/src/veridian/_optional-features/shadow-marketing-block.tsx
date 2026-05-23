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
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import type { ServiceKey, ShadowIconKey } from '../types';
import { SHADOW_MARKETING, buildMailto } from '../types';
import { cn } from '../utils';

/**
 * ShadowMarketingBlock : bloc "shadow" affiché pour un service non actif chez
 * le client. Style volontairement muté (gris, opacité, icône lock en coin),
 * avec hover subtil qui invite à cliquer sur le CTA mailto pour contacter
 * Robert et activer le service.
 *
 * Moteur commercial passif : chaque login client = une impression
 * publicitaire discrète pour un service payant.
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

export function ShadowMarketingBlock({
  service,
  siteDomain,
  className,
}: {
  service: ServiceKey;
  siteDomain: string;
  className?: string;
}) {
  const entry = SHADOW_MARKETING[service];
  const Icon = ICON_MAP[entry.icon];
  const mailto = buildMailto(service, siteDomain);

  return (
    <a
      href={mailto}
      className={cn('group block', className)}
      data-testid={`shadow-${service}`}
      data-service={service}
    >
      <Card
        className={cn(
          'relative h-full border-dashed border-border/60 bg-muted/20',
          'transition-all duration-200',
          'hover:border-primary/40 hover:bg-muted/40 hover:shadow-sm',
        )}
      >
        <div className="absolute right-3 top-3 text-muted-foreground/60 transition-colors group-hover:text-muted-foreground">
          <Lock className="h-3.5 w-3.5" />
        </div>

        <CardContent className="flex h-full flex-col gap-3 pt-6">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md',
                'bg-muted/40 text-muted-foreground/70',
                'transition-colors group-hover:bg-muted/60 group-hover:text-muted-foreground',
              )}
            >
              <Icon className="h-4 w-4" />
            </div>
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
              A activer
            </span>
          </div>

          <h3 className="text-base font-semibold text-muted-foreground group-hover:text-foreground">
            {entry.title}
          </h3>

          <p className="flex-1 text-sm leading-relaxed text-muted-foreground/80">
            {entry.description}
          </p>

          <div
            className={cn(
              'mt-2 inline-flex items-center gap-1.5 self-start rounded-md border border-border/70 px-3 py-1.5 text-xs font-medium text-muted-foreground',
              'transition-colors group-hover:border-primary/60 group-hover:text-foreground',
            )}
          >
            {entry.ctaLabel}
            <ArrowUpRight className="h-3 w-3" />
          </div>
        </CardContent>
      </Card>
    </a>
  );
}
