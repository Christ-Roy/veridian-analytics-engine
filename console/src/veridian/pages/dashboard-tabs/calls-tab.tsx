import { useCalls } from './calls-hooks';
import {
  CallsReady,
  CallsError,
  CallsNotConnected,
  CallsSkeleton,
} from './calls-tab-views';

/**
 * CallsTab — tab "Appels" du dashboard Veridian (ticket U9).
 *
 * Consomme `GET /api/admin/tenant/:wsId/calls?days=30` via le hook `useCalls`
 * (endpoint livré par B-VOIP). Contrairement aux tabs Forms/GSC/Push qui sont
 * encore des stubs « bientôt », ce tab est une VRAIE page :
 *
 *   - Bandeau de stats : total appels, appels manqués, durée moyenne,
 *     taux de réponse
 *   - Graphe appels par jour (barres, manqués en surcouche)
 *   - Table des appels : date, direction, numéro, durée, statut, enregistrement
 *
 * États gérés (via `useCalls`) :
 *   - loading        → skeleton shimmer
 *   - error          → carte erreur + bouton Réessayer
 *   - not-connected  → onboarding « Connectez votre téléphonie » + CTA Settings
 *                      (le 404 « endpoint B-VOIP pas encore livré » tombe ici)
 *   - ready, 0 appel → empty state « aucun appel sur la période »
 *   - ready, N appels → render complet
 *
 * Ce fichier est volontairement mince : il câble le hook aux vues. Les
 * composants de présentation vivent dans `calls-tab-views.tsx`.
 *
 * Props :
 *   - `workspaceId` : id staminads du workspace (pour le fetch)
 *   - `siteDomain`  : domaine du site (mailto support)
 *   - `onOpenSettings` : callback du CTA « Configurer la téléphonie » →
 *      la route navigue vers le tab Settings (U8). Optionnel : fallback mailto.
 *   - `days` : fenêtre temporelle (défaut 30).
 */

export interface CallsTabProps {
  workspaceId: string;
  siteDomain: string;
  onOpenSettings?: () => void;
  days?: number;
}

export function CallsTab({
  workspaceId,
  siteDomain,
  onOpenSettings,
  days = 30,
}: CallsTabProps) {
  const { state, reload } = useCalls(workspaceId, days);

  return (
    <div
      className="veridian-fade-in-delay-1 space-y-6"
      data-testid="calls-tab"
    >
      {state.kind === 'loading' && <CallsSkeleton />}
      {state.kind === 'error' && (
        <CallsError error={state.error} onRetry={reload} />
      )}
      {state.kind === 'not-connected' && (
        <CallsNotConnected
          siteDomain={siteDomain}
          onOpenSettings={onOpenSettings}
        />
      )}
      {state.kind === 'ready' && (
        <CallsReady data={state.data} days={days} />
      )}
    </div>
  );
}

/**
 * Variante "stub" — gardée pour cohérence d'API avec les autres tabs
 * (`FormsTabStub`, `GscTabStub`, `PushTabStub`). Le tab Calls étant une vraie
 * page, le stub redirige simplement vers le composant réel.
 */
export function CallsTabStub(props: CallsTabProps) {
  return <CallsTab {...props} />;
}
