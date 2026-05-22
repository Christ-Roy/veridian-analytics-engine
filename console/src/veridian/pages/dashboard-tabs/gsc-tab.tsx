import { Search } from 'lucide-react';
import { TabSoonLayout, MockupCard } from './_shared';
import { buildMailto } from '../../types';

/**
 * GscTabStub — placeholder esthétique pour la future page Search Console.
 *
 * Disponible après merge du ticket A4 (gsc-integration-port). En attendant,
 * cette tab montre un mockup : top requêtes, positions moyennes, clics 30j.
 */
export function GscTabStub({ siteDomain }: { siteDomain: string }) {
  return (
    <TabSoonLayout
      ticketRef="A4"
      icon={Search}
      title="Découvrez sur quoi Google vous trouve"
      pitch="Bientôt : connectez votre Google Search Console à Veridian et voyez chaque jour vos requêtes, clics et positions. Repérez les pages qui montent, celles qui décrochent, et les mots-clés sur lesquels investir. Plus besoin d'aller fouiller GSC manuellement — tout est ici, dans votre dashboard."
      ctaLabel="Connecter mon Search Console"
      mailto={buildMailto('gsc', siteDomain)}
    >
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <MockupCard
          title="Top requêtes"
          hint="30 derniers jours"
          className="lg:col-span-2"
          preview={
            <div className="space-y-2 text-[11px]">
              {[
                { q: 'tarif menuisier paris', pos: 4.2, clicks: 132 },
                { q: 'devis fenêtre alu', pos: 6.8, clicks: 89 },
                { q: 'porte d’entrée bois prix', pos: 12.1, clicks: 47 },
                { q: 'volets roulants installateur', pos: 3.5, clicks: 124 },
                { q: 'menuiserie sur mesure', pos: 8.7, clicks: 62 },
              ].map((row) => (
                <div
                  key={row.q}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-md border border-border/40 bg-background/30 px-3 py-2"
                >
                  <div className="truncate text-muted-foreground/80">
                    {row.q}
                  </div>
                  <div className="tabular-nums text-muted-foreground/60">
                    pos. {row.pos}
                  </div>
                  <div className="tabular-nums text-foreground/70">
                    {row.clicks} clics
                  </div>
                </div>
              ))}
            </div>
          }
        />
        <MockupCard
          title="Position moyenne"
          hint="évolution"
          preview={
            <div className="space-y-3">
              <div className="text-4xl font-semibold tabular-nums text-foreground/70">
                7.3
              </div>
              <div className="text-[11px] text-emerald-400/80">
                ↑ 1.4 vs mois dernier
              </div>
              <svg
                viewBox="0 0 160 40"
                className="h-10 w-full"
                preserveAspectRatio="none"
                aria-hidden
              >
                <defs>
                  <linearGradient id="gsc-grad" x1="0" x2="0" y1="0" y2="1">
                    <stop
                      offset="0%"
                      stopColor="hsl(174 72% 56%)"
                      stopOpacity="0.3"
                    />
                    <stop
                      offset="100%"
                      stopColor="hsl(174 72% 56%)"
                      stopOpacity="0"
                    />
                  </linearGradient>
                </defs>
                <path
                  d="M 0 32 C 20 28, 40 30, 60 24 S 100 12, 130 14 L 160 10 L 160 40 L 0 40 Z"
                  fill="url(#gsc-grad)"
                />
                <path
                  d="M 0 32 C 20 28, 40 30, 60 24 S 100 12, 130 14 L 160 10"
                  fill="none"
                  stroke="hsl(174 72% 56%)"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          }
        />
      </div>
    </TabSoonLayout>
  );
}
