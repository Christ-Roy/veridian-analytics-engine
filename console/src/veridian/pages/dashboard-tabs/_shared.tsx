import type { ReactNode } from 'react';
import { ArrowUpRight, Sparkles } from 'lucide-react';
import { Card, CardContent } from '../../ui/card';
import { cn } from '../../utils';

/**
 * Layout commun aux tabs "coming soon" du dashboard Veridian.
 *
 * Chaque tab (Forms B1, GSC A4, Push B2) est un stub esthétique avec :
 *   - Hero "🚀 Bientôt disponible" + icône signature du service
 *   - Description vendeuse de ce que le service apportera une fois activé
 *   - Mockup visuel (cards greyed) pour donner une vibe pro
 *   - CTA mailto pour exprimer l'intérêt avant que la feature ne livre
 *
 * Robert peut montrer ces tabs en démo client sans rougir : pas de "TODO"
 * moche, pas de page blanche, c'est du teasing produit propre.
 */

export function TabSoonLayout({
  ticketRef,
  icon: Icon,
  title,
  pitch,
  ctaLabel,
  mailto,
  children,
}: {
  ticketRef: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  pitch: string;
  ctaLabel: string;
  mailto: string;
  children?: ReactNode;
}) {
  return (
    <div
      className="veridian-fade-in-delay-1 space-y-6"
      data-testid={`tab-soon-${ticketRef.toLowerCase()}`}
    >
      <Card className="relative overflow-hidden border-border/60 bg-card/80">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background:
              'radial-gradient(ellipse at top left, hsl(174 72% 56% / 0.10), transparent 60%)',
          }}
          aria-hidden
        />
        <CardContent className="relative flex flex-col gap-6 p-8 md:flex-row md:items-center md:justify-between md:p-10">
          <div className="flex items-start gap-5">
            <div className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-xl border border-primary/30 bg-primary/10 text-primary">
              <Icon className="h-7 w-7" />
              <span
                className="absolute -top-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-primary/40 bg-card text-primary"
                aria-hidden
              >
                <Sparkles className="h-3 w-3" />
              </span>
            </div>
            <div className="space-y-2 max-w-xl">
              <div className="flex items-center gap-2">
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
                  Bientôt
                </span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70">
                  ticket {ticketRef}
                </span>
              </div>
              <h2 className="text-2xl font-semibold tracking-tight">{title}</h2>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {pitch}
              </p>
            </div>
          </div>
          <a
            href={mailto}
            className={cn(
              'inline-flex shrink-0 items-center gap-2 self-start rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground',
              'transition-transform hover:scale-[1.02]',
            )}
          >
            {ctaLabel}
            <ArrowUpRight className="h-4 w-4" />
          </a>
        </CardContent>
      </Card>

      {children}
    </div>
  );
}

/**
 * Carte mockup gris-pâle qui simule une future widget du tab.
 * Sert à donner une idée visuelle de ce que sera la page sans coder la vraie.
 */
export function MockupCard({
  title,
  hint,
  preview,
  className,
}: {
  title: string;
  hint?: string;
  preview: ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        'border-dashed border-border/60 bg-card/40',
        className,
      )}
    >
      <CardContent className="space-y-3 p-5">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
          {hint && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">
              {hint}
            </span>
          )}
        </div>
        <div className="opacity-60">{preview}</div>
      </CardContent>
    </Card>
  );
}
