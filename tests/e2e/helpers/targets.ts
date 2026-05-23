/**
 * Cibles E2E — résolution staging/prod/demo.
 *
 * Une seule source de vérité pour les URLs. Si une URL change (ex: nouveau
 * domaine staging), on update ici, tous les tests suivent.
 */

export type TargetName =
  | "staging"
  | "prod"
  | "demo-prod"
  | "demo-staging";

export interface Target {
  name: TargetName;
  /** URL de la console (UI staminads + Veridian). */
  consoleUrl: string;
  /** URL de l'engine (API staminads). */
  engineUrl: string;
  /** URL du bridge Veridian (API HMAC + admin Bearer). */
  bridgeUrl: string;
  /** Domaine racine pour les checks SSL. */
  hostname: string;
  /** true = environnement public (peut être probé en lecture) */
  isPublic: boolean;
  /** true = mode démo (IS_DEMO=true côté API). */
  isDemo: boolean;
}

export const TARGETS: Record<TargetName, Target> = {
  staging: {
    name: "staging",
    consoleUrl: "https://analytics-engine.staging.veridian.site",
    engineUrl: "https://analytics-engine.staging.veridian.site",
    bridgeUrl: "https://analytics-engine-bridge.staging.veridian.site",
    hostname: "analytics-engine.staging.veridian.site",
    isPublic: false,
    isDemo: false,
  },
  prod: {
    name: "prod",
    consoleUrl: "https://analytics-engine.app.veridian.site",
    engineUrl: "https://analytics-engine.app.veridian.site",
    bridgeUrl: "https://analytics-engine-bridge.app.veridian.site",
    hostname: "analytics-engine.app.veridian.site",
    isPublic: true,
    isDemo: false,
  },
  "demo-prod": {
    name: "demo-prod",
    consoleUrl: "https://demo-analytics.veridian.site",
    engineUrl: "https://demo-analytics.veridian.site",
    // La démo a son propre bridge / pas de bridge — selon l'archi, ce champ
    // est best-effort. Pour les tests démo, on tape surtout l'engine.
    bridgeUrl: "https://demo-analytics.veridian.site",
    hostname: "demo-analytics.veridian.site",
    isPublic: true,
    isDemo: true,
  },
  "demo-staging": {
    name: "demo-staging",
    consoleUrl: "https://demo-staging-analytics.veridian.site",
    engineUrl: "https://demo-staging-analytics.veridian.site",
    bridgeUrl: "https://demo-staging-analytics.veridian.site",
    hostname: "demo-staging-analytics.veridian.site",
    isPublic: false,
    isDemo: true,
  },
};

export function getTarget(name: TargetName): Target {
  const t = TARGETS[name];
  if (!t) {
    throw new Error(
      `Unknown E2E target: ${name}. Valid: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  return t;
}

/** Tous les targets non-démo (pour tests cross-target). */
export const ENGINE_TARGETS: TargetName[] = ["staging", "prod"];

/** Tous les targets démo (pour tests démo cross-env). */
export const DEMO_TARGETS: TargetName[] = ["demo-prod", "demo-staging"];

/** Tous les targets connus. */
export const ALL_TARGETS: TargetName[] = [
  "staging",
  "prod",
  "demo-prod",
  "demo-staging",
];
