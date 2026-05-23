import { Bell } from 'lucide-react';
import { TabSoonLayout, MockupCard } from './_shared';
import { buildMailto } from '../../types';

/**
 * PushTabStub — placeholder esthétique pour la future page Notifications Push.
 *
 * Disponible après merge du ticket B2 (push-pwa-port). En attendant, cette
 * tab montre un mockup : audience abonnés + composer notification + stats.
 */
export function PushTabStub({ siteDomain }: { siteDomain: string }) {
  return (
    <TabSoonLayout
      ticketRef="B2"
      icon={Bell}
      title="Renvoyez vos visiteurs sur votre site"
      pitch="Bientôt : installez la PWA Veridian sur votre site pour que vos visiteurs puissent l'ajouter en raccourci sur leur écran d'accueil. Envoyez-leur ensuite des notifications push (promo du mois, nouvel article, rappel) directement sur leur téléphone. Le canal qui marche le mieux pour ramener un visiteur 2x."
      ctaLabel="Activer les notifications"
      mailto={buildMailto('push', siteDomain)}
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <MockupCard
          title="Abonnés push"
          hint="total"
          preview={
            <div className="space-y-1">
              <div className="text-4xl font-semibold tabular-nums text-foreground/70">
                1 247
              </div>
              <div className="text-[11px] text-emerald-400/80">
                ↑ 84 cette semaine
              </div>
            </div>
          }
        />
        <MockupCard
          title="Taux d'ouverture"
          hint="dernière campagne"
          preview={
            <div className="space-y-3">
              <div className="text-4xl font-semibold tabular-nums text-foreground/70">
                42%
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted/40">
                <div
                  className="h-full bg-primary/50"
                  style={{ width: '42%' }}
                />
              </div>
              <div className="text-[10px] text-muted-foreground/60">
                vs 18% email moyenne secteur
              </div>
            </div>
          }
        />
        <MockupCard
          title="Aperçu push"
          hint="iOS"
          preview={
            <div className="space-y-2 rounded-lg border border-border/50 bg-background/60 p-3">
              <div className="flex items-center gap-2">
                <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/20 text-primary">
                  <Bell className="h-3.5 w-3.5" />
                </div>
                <div className="flex-1">
                  <div className="text-[10px] font-medium text-foreground/80">
                    {siteDomain}
                  </div>
                  <div className="text-[9px] uppercase tracking-wider text-muted-foreground/60">
                    maintenant
                  </div>
                </div>
              </div>
              <div className="text-[11px] font-semibold text-foreground/80">
                Nouvelle offre du mois 🌿
              </div>
              <div className="text-[10px] leading-relaxed text-muted-foreground/70">
                −15% sur tous nos services jusqu'au 31. Cliquez pour
                réserver.
              </div>
            </div>
          }
        />
      </div>
    </TabSoonLayout>
  );
}
