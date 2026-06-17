/**
 * Génération centralisée du snippet `<script>` tracker Veridian Analytics.
 *
 * SOURCE UNIQUE de vérité pour le snippet à coller chez le client. Utilisé par :
 *   - l'onboarding wizard `welcome.tsx` (première impression client)
 *   - la page `install-sdk.tsx` (étape d'installation du workspace)
 *   - l'onglet « SDK » de `settings.tsx`
 *
 * Avant cette centralisation, les trois emplacements dupliquaient la string avec
 * des URLs divergentes (`/sdk/staminads_<version>.min.js`, `/sdk/staminads.min.js`)
 * qui pointaient TOUTES vers du 404 : le backend ne sert le bundle QUE sous
 * `/sdk/v1/tracker.js` (cf. `api/src/sdk/sdk.controller.ts`, `@Controller('sdk/v1')`).
 *
 * Le versioning est porté par le CHEMIN (`/v1/`), pas par le filename : pas de
 * `__APP_VERSION__` dans l'URL. Le cache-busting est géré côté controller via
 * `Cache-Control: max-age=3600`. Un breaking change shipperait sous `/sdk/v2/`.
 */

/** Chemin public (frozen) du bundle UMD tracker servi par le SdkController. */
export const TRACKER_SDK_PATH = '/sdk/v1/tracker.js';

export interface BuildTrackerSnippetOptions {
  /** Id staminads du workspace, pré-rempli dans `StaminadsConfig.workspace_id`. */
  workspaceId: string;
  /**
   * URL publique de l'endpoint analytics (prod :
   * `https://analytics-engine.app.veridian.site`). Sert à la fois d'`endpoint`
   * d'ingestion et de base pour charger le bundle.
   */
  endpoint: string;
}

/**
 * Construit le snippet `<script>` Veridian Analytics à coller dans le `<head>`.
 * Pointe vers l'endpoint public du tracker (analytics-engine) avec le
 * workspaceId pré-rempli. Le tracking visiteur est actif par défaut côté SDK ;
 * `trackSPA`/`trackScroll` couvrent les sites en single-page app.
 */
export function buildTrackerSnippet(opts: BuildTrackerSnippetOptions): string {
  // On retire un éventuel slash final pour un endpoint propre.
  const endpoint = opts.endpoint.replace(/\/+$/, '');
  return `<!-- Veridian Analytics -->
<script>
  window.StaminadsConfig = {
    workspace_id: ${JSON.stringify(opts.workspaceId)},
    endpoint: ${JSON.stringify(endpoint)},
    trackSPA: true,
    trackScroll: true
  };
</script>
<script async src="${endpoint}${TRACKER_SDK_PATH}"></script>
<!-- /Veridian Analytics -->`;
}
