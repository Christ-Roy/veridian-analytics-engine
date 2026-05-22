import { Inbox } from 'lucide-react';
import { TabSoonLayout, MockupCard } from './_shared';
import { buildMailto } from '../../types';

/**
 * FormsTabStub — placeholder esthétique pour la future page Formulaires.
 *
 * Disponible après merge du ticket B1 (forms-leads-port). En attendant,
 * cette tab montre un mockup propre pour donner une idée de ce que sera
 * la page : table des leads + détail soumission + export CSV.
 */
export function FormsTabStub({ siteDomain }: { siteDomain: string }) {
  return (
    <TabSoonLayout
      ticketRef="B1"
      icon={Inbox}
      title="Captez et gérez vos leads"
      pitch="Bientôt : chaque soumission de formulaire de votre site sera enregistrée ici. Vous verrez l'email, le téléphone, la page d'origine, l'UTM source — et serez notifié en temps réel sur Telegram. Aucune intégration technique côté client : Robert pose le snippet, c'est tout."
      ctaLabel="Me prévenir au lancement"
      mailto={buildMailto('forms', siteDomain)}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        <MockupCard
          title="Derniers leads"
          hint="14 cette semaine"
          preview={
            <div className="space-y-2">
              {[
                { name: 'Marie Lefèvre', src: '/contact', when: 'il y a 12 min' },
                { name: 'Thomas D.', src: '/devis', when: 'il y a 1h' },
                { name: 'Anne-Sophie M.', src: '/contact', when: 'il y a 3h' },
              ].map((lead) => (
                <div
                  key={lead.name}
                  className="flex items-center justify-between rounded-md border border-border/40 bg-background/30 px-3 py-2"
                >
                  <div>
                    <div className="text-xs font-medium text-foreground/70">
                      {lead.name}
                    </div>
                    <div className="text-[10px] text-muted-foreground/60">
                      {lead.src}
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground/60">
                    {lead.when}
                  </div>
                </div>
              ))}
            </div>
          }
        />
        <MockupCard
          title="Taux de conversion"
          hint="par page"
          preview={
            <div className="space-y-2">
              {[
                { label: '/contact', pct: 8.4 },
                { label: '/devis', pct: 5.1 },
                { label: '/services', pct: 1.8 },
              ].map((row) => (
                <div key={row.label}>
                  <div className="flex justify-between text-[11px] text-muted-foreground/70">
                    <span>{row.label}</span>
                    <span>{row.pct}%</span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/40">
                    <div
                      className="h-full bg-primary/40"
                      style={{ width: `${Math.min(100, row.pct * 8)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          }
        />
        <MockupCard
          title="Source des leads"
          hint="UTM"
          preview={
            <div className="space-y-2 text-[11px]">
              {[
                { label: 'google / organic', pct: 62 },
                { label: 'direct', pct: 24 },
                { label: 'google / cpc', pct: 14 },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between"
                >
                  <span className="text-muted-foreground/80">{row.label}</span>
                  <span className="tabular-nums text-foreground/60">
                    {row.pct}%
                  </span>
                </div>
              ))}
            </div>
          }
        />
      </div>
    </TabSoonLayout>
  );
}
