import { ShieldAlert, X } from 'lucide-react';

/**
 * Bandeau affiché quand un superadmin consulte le dashboard d'un autre tenant
 * en mode impersonation. Rappelle que la vue est falsifiée et permet de
 * quitter en un clic.
 *
 * Composant présentationnel (props in, JSX out) — la nav vers `/dashboard`
 * est déléguée à la page consommatrice via `exitHref` (défaut `/dashboard`).
 * Visible uniquement si `impersonating=true` (sinon retourne null).
 */
export function ImpersonationBanner({
  tenantName,
  tenantSlug,
  impersonating = true,
  exitHref = '/dashboard',
}: {
  tenantName: string;
  tenantSlug: string;
  impersonating?: boolean;
  exitHref?: string;
}) {
  if (!impersonating) return null;

  return (
    <div
      className="mb-4 flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm"
      data-testid="impersonation-banner"
      data-tenant-slug={tenantSlug}
    >
      <ShieldAlert className="h-4 w-4 text-amber-400" aria-hidden />
      <div className="flex-1 text-amber-700 dark:text-amber-200">
        <span className="font-semibold">Mode admin</span>
        <span className="text-amber-700/70 dark:text-amber-200/70">
          {' — vous consultez le dashboard de '}
        </span>
        <span className="font-semibold">{tenantName}</span>
      </div>
      <a
        href={exitHref}
        className="inline-flex items-center gap-1 rounded-md border border-amber-500/30 px-2 py-1 text-xs text-amber-700 hover:bg-amber-500/20 dark:text-amber-200"
        data-testid="exit-impersonation"
      >
        <X className="h-3 w-3" />
        Quitter
      </a>
    </div>
  );
}
