/**
 * Dual-tracking — génération des snippets pour la phase de transition.
 *
 * Pendant les 30 jours d'observation (ticket D2), chaque site client tire
 * DEUX trackers en parallèle :
 *   1. le tracker LEGACY `veridian-analytics` (déjà en place — on n'y touche pas)
 *   2. le tracker STAMINADS (nouveau — on l'ajoute)
 *
 * Ce module construit le bloc `<head>` complet (legacy + staminads) à coller,
 * et un bloc "staminads-only" pour les sites où le tracker legacy est déjà là.
 *
 * Fonctions PURES, testées en isolation.
 */

export interface DualTrackingInput {
  /** workspaceId staminads du client (renvoyé par provision-existing-tenant). */
  workspaceId: string;
  /** siteKey legacy — utilisé par le tracker legacy. */
  legacySiteKey: string;
  /** URL publique du tracker staminads. */
  staminadsEndpoint: string;
  /** URL publique de l'ingestion legacy. */
  legacyEndpoint: string;
  /** active visitor_id dans le snippet staminads (pré-requis Phase 2). */
  visitorIdEnabled: boolean;
}

/** Retire les slashes finaux d'une URL pour une concaténation propre. */
function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Snippet staminads seul — le `<script>` à AJOUTER dans le `<head>` à côté
 * du tracker legacy existant.
 */
export function buildStaminadsSnippet(input: {
  workspaceId: string;
  staminadsEndpoint: string;
  visitorIdEnabled: boolean;
}): string {
  const endpoint = trimSlash(input.staminadsEndpoint);
  const visitorAttr = input.visitorIdEnabled
    ? ' data-visitor-id="true"'
    : "";
  return [
    `<!-- Veridian Analytics (staminads) — ajouté pour la migration, NE PAS retirer le tracker legacy -->`,
    `<script`,
    `  defer`,
    `  src="${endpoint}/js/script.js"`,
    `  data-workspace-id="${input.workspaceId}"`,
    `  data-api-endpoint="${endpoint}/api/track"${visitorAttr}`,
    `></script>`,
  ].join("\n");
}

/**
 * Snippet legacy — référence de ce qui DOIT déjà être en place. On ne le
 * génère que pour documentation / vérification (le script ne le repose pas).
 */
export function buildLegacySnippet(input: {
  legacySiteKey: string;
  legacyEndpoint: string;
}): string {
  const endpoint = trimSlash(input.legacyEndpoint);
  return [
    `<!-- Veridian Analytics (legacy) — déjà en place, à conserver pendant la transition -->`,
    `<script defer src="${endpoint}/tracker.js" data-site-key="${input.legacySiteKey}"></script>`,
  ].join("\n");
}

/**
 * Bloc `<head>` complet dual-tracking : legacy + staminads.
 * Utilisé dans le fichier `out/snippets-by-site.md` généré par le script.
 */
export function buildDualTrackingBlock(input: DualTrackingInput): string {
  return [
    buildLegacySnippet({
      legacySiteKey: input.legacySiteKey,
      legacyEndpoint: input.legacyEndpoint,
    }),
    "",
    buildStaminadsSnippet({
      workspaceId: input.workspaceId,
      staminadsEndpoint: input.staminadsEndpoint,
      visitorIdEnabled: input.visitorIdEnabled,
    }),
  ].join("\n");
}
