/**
 * Score Veridian global — port de la lib legacy `veridian-analytics/lib/user-tenant.ts`
 * adapté pour lire les counts depuis staminads (ClickHouse) au lieu de Postgres.
 *
 * Algo (pondération par service actif sur les 30 derniers jours) :
 *   - pageviews : 30 points si > 0
 *   - forms     : 20 points si > 0   (goal events / proxy "form_submission")
 *   - calls     : 20 points si > 0   (V1 : toujours 0, VoIP différé)
 *   - gsc       : 20 points si > 0   (V1 : toujours 0, A4 fournira la table)
 *   - ads       : 5 points si > 0    (V2)
 *   - pagespeed : 5 points si > 0    (V2)
 *
 * Score capé à 100. Label qualitatif :
 *   90+ : "Excellent"
 *   70+ : "Très bon"
 *   50+ : "Bon"
 *   30+ : "À améliorer"
 *   *   : "À démarrer"
 *
 * Référence legacy : `veridian-analytics/lib/user-tenant.ts` (computeScore, scoreLabel)
 *                  + `veridian-analytics/lib/tenant-status.ts` (KNOWN_SERVICES).
 */

export const KNOWN_SERVICES = [
  "pageviews",
  "forms",
  "calls",
  "gsc",
  "ads",
  "pagespeed",
] as const;

export type ServiceKey = (typeof KNOWN_SERVICES)[number];

/**
 * Pondération de chaque service dans le score global. Garde la même
 * répartition que le ticket A1 (cf. todo/sprint-2026-05-22-mega).
 */
export const SERVICE_WEIGHTS: Record<ServiceKey, number> = {
  pageviews: 30,
  forms: 20,
  calls: 20,
  gsc: 20,
  ads: 5,
  pagespeed: 5,
};

export interface ServiceCounts {
  pageviews: number;
  forms: number;
  calls: number;
  gsc: number;
  ads: number;
  pagespeed: number;
}

export interface ScoreResult {
  score: number;
  label: string;
  services: {
    active: ServiceKey[];
    inactive: ServiceKey[];
  };
}

/**
 * Calcule le score Veridian à partir des counts par service.
 * Chaque service avec count > 0 contribue de son poids. Score capé à 100.
 */
export function computeScore(counts: ServiceCounts): ScoreResult {
  const active: ServiceKey[] = [];
  const inactive: ServiceKey[] = [];
  let raw = 0;

  for (const service of KNOWN_SERVICES) {
    const count = counts[service] ?? 0;
    if (count > 0) {
      active.push(service);
      raw += SERVICE_WEIGHTS[service];
    } else {
      inactive.push(service);
    }
  }

  const score = Math.min(100, raw);
  return {
    score,
    label: scoreLabel(score),
    services: { active, inactive },
  };
}

/**
 * Label qualitatif pour un score Veridian. Seuils définis par le ticket A1.
 */
export function scoreLabel(score: number): string {
  if (score >= 90) return "Excellent";
  if (score >= 70) return "Très bon";
  if (score >= 50) return "Bon";
  if (score >= 30) return "À améliorer";
  return "À démarrer";
}

/**
 * Interface du fetcher utilisé pour récupérer les counts depuis staminads.
 * Abstrait pour pouvoir mocker en tests sans dépendre de fetch global.
 *
 * Pourquoi pas un client staminads injecté ? Le bridge fait déjà ses appels
 * fetch dans app.ts pour des raisons historiques (POC). On garde le même
 * pattern : la lib `score.ts` reste pure (pas de fetch), l'endpoint dans
 * app.ts fait les appels et passe les counts à `computeScore`.
 */
export interface CountsFetcher {
  fetchCounts(workspaceId: string): Promise<ServiceCounts>;
}

/**
 * Helper : construit les counts depuis une réponse staminads analytics.query.
 *
 * Pour V1 :
 *   - `pageviews` = somme de la métrique `pageviews` retournée par staminads
 *   - `forms`     = somme de la métrique `goals` (proxy "form_submission")
 *   - `calls`     = 0 (VoIP différé en Phase 5)
 *   - `gsc`       = 0 (TODO: ticket A4 fournira la table bridge `GscDaily`)
 *   - `ads`       = 0 (TODO: V2 Google Ads)
 *   - `pagespeed` = 0 (TODO: V2 PageSpeed monitoring)
 *
 * `rows` est typé loose parce que staminads renvoie un shape dynamique selon
 * les metrics demandées. On agrège défensivement (toute valeur non-number → 0).
 */
export function buildCountsFromStaminadsRows(
  rows: Array<Record<string, unknown>>,
): ServiceCounts {
  let pageviews = 0;
  let goals = 0;

  for (const row of rows) {
    const pv = row.pageviews;
    if (typeof pv === "number" && Number.isFinite(pv)) pageviews += pv;
    const g = row.goals;
    if (typeof g === "number" && Number.isFinite(g)) goals += g;
  }

  return {
    pageviews,
    forms: goals,
    // TODO(A5-VoIP) : brancher SipCall bridge quand la table sera dispo.
    calls: 0,
    // TODO(A4-GSC) : lire la table `GscDaily` quand le ticket A4 sera livré.
    gsc: 0,
    // TODO(V2-ads) : brancher Google Ads API.
    ads: 0,
    // TODO(V2-pagespeed) : brancher monitoring PageSpeed hebdo.
    pagespeed: 0,
  };
}
