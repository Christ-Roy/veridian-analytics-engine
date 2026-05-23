import { Sparkles, BarChart3, ShieldCheck, Megaphone, ArrowRight } from 'lucide-react';
import { useAuth } from '../lib/useAuth';
import { demoContactMailto } from '../lib/demo-config';
import './theme.css';

/**
 * Demo-mode placeholder for the Veridian-flavored tabs.
 *
 * The Veridian add-ons (Score, Services, Shadow Marketing, Forms, GSC,
 * Push, Calls) live behind the `veridian-bridge` admin endpoints. The
 * public demo (`IS_DEMO=true`) intentionally ships only the read-only
 * staminads engine without the bridge — see `compose/demo.yml`. Rather
 * than expose raw 404s on `/api/admin/tenant/*`, this component renders
 * a clean "preview only" state that explains the value prop and points
 * to a real demo/account request.
 *
 * Rendered exclusively from inside `<div class="veridian-scope">` so the
 * Veridian dark theme applies even when the host AntDesign console is in
 * light mode.
 */
export function VeridianDemoComingSoon({
  tenantName,
  tenantDomain,
}: {
  tenantName?: string;
  tenantDomain?: string;
}) {
  const { publicConfig } = useAuth();
  const mailto = publicConfig
    ? demoContactMailto(publicConfig)
    : 'mailto:robert.brunon@veridian.site';

  return (
    <div
      className="veridian-scope min-h-screen px-4 py-8 sm:px-6 lg:px-10"
      data-testid="veridian-demo-coming-soon"
    >
      <div className="mx-auto max-w-4xl space-y-8">
        <header className="space-y-2">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            <Sparkles className="h-3 w-3 text-primary" />
            Veridian Analytics
          </div>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {tenantName ?? 'Mon dashboard'}
          </h1>
          {tenantDomain && (
            <p className="text-sm text-muted-foreground">{tenantDomain}</p>
          )}
        </header>

        <div className="rounded-2xl border border-border/80 bg-card p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-lg bg-primary/10 p-3 text-primary">
              <Sparkles className="h-6 w-6" />
            </div>
            <div className="space-y-2">
              <h2 className="text-xl font-semibold tracking-tight">
                Bientôt disponible dans la démo
              </h2>
              <p className="text-sm text-muted-foreground">
                Le tableau de bord Veridian apporte par-dessus l'analytics
                classique des outils dédiés à l'acquisition : Score Veridian
                global, état des services, Shadow Marketing automatisé, suivi
                des formulaires, Google Search Console, notifications push et
                logs d'appels VoIP. Ces fonctionnalités tournent sur un service
                dédié (veridian-bridge) que la démo publique ne déploie pas
                volontairement. Sur un compte réel, vous y avez accès dès
                l'onboarding.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <PreviewCard
            icon={<BarChart3 className="h-5 w-5" />}
            title="Score Veridian"
            description="Note 0–100 calculée sur l'activité d'acquisition (pageviews, formulaires, calls, GSC) — un seul chiffre pour piloter."
          />
          <PreviewCard
            icon={<ShieldCheck className="h-5 w-5" />}
            title="Services & Settings"
            description="État GSC, VoIP, push, formulaires en un coup d'œil. Branchement self-service depuis l'onglet Réglages."
          />
          <PreviewCard
            icon={<Megaphone className="h-5 w-5" />}
            title="Shadow Marketing"
            description="Suggestions d'activation par canal, avec mailto pré-rempli pour relancer prospects et partenaires."
          />
        </div>

        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <p className="text-sm font-semibold text-foreground">
                Envie de voir ces fonctionnalités sur votre site ?
              </p>
              <p className="text-xs text-muted-foreground">
                Compte gratuit en quelques minutes — aucune carte demandée.
              </p>
            </div>
            <a
              href={mailto}
              className="inline-flex items-center gap-2 self-start rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 sm:self-auto"
              data-demo-cta="veridian-tab"
            >
              Demander un compte gratuit
              <ArrowRight className="h-4 w-4" />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="rounded-xl border border-border/80 bg-card p-5">
      <div className="mb-3 inline-flex items-center justify-center rounded-lg bg-primary/10 p-2 text-primary">
        {icon}
      </div>
      <h3 className="mb-1 text-sm font-semibold tracking-tight">{title}</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {description}
      </p>
    </div>
  );
}
