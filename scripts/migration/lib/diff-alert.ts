/**
 * Logique d'alerting du dual-tracking — fonctions PURES, testées en isolation.
 *
 * Pendant les 30 jours d'observation (ticket D2), on compare quotidiennement
 * les pageviews legacy vs staminads par tenant. Si l'écart dépasse 10 % pendant
 * 3 jours consécutifs sur un tenant → alerte Telegram (le tracking staminads
 * a un problème, ne PAS faire le cutover).
 *
 * Ce module ne fait PAS d'I/O : il prend les chiffres déjà collectés et
 * applique la règle de seuil. Le script `migration-diff-alert.sh` se charge
 * de collecter les données et d'envoyer l'alerte.
 */

/** Un point de comparaison : pageviews des 2 stacks pour 1 tenant 1 jour. */
export interface DiffPoint {
  /** date du jour observé (YYYY-MM-DD). */
  date: string;
  pageviewsLegacy: number;
  pageviewsStaminads: number;
}

/** Série temporelle de diff pour un tenant. */
export interface TenantDiffSeries {
  tenant: string;
  /** points triés par date croissante. */
  points: DiffPoint[];
}

/**
 * Écart relatif entre legacy et staminads, en pourcentage absolu.
 *
 * Base de comparaison = legacy (la source de vérité historique). Si legacy = 0 :
 *   - staminads = 0 aussi → 0 % (cohérent)
 *   - staminads > 0       → 100 % (staminads voit du trafic que legacy ne voit
 *     pas — anormal, à signaler)
 */
export function relativeDiffPct(point: DiffPoint): number {
  const { pageviewsLegacy: legacy, pageviewsStaminads: staminads } = point;
  if (legacy === 0) {
    return staminads === 0 ? 0 : 100;
  }
  return (Math.abs(staminads - legacy) / legacy) * 100;
}

/** Code couleur "feu" pour le dashboard. vert < 5 %, jaune 5-10 %, rouge > 10 %. */
export function diffSeverity(pct: number): "green" | "yellow" | "red" {
  if (pct > 10) return "red";
  if (pct >= 5) return "yellow";
  return "green";
}

export interface AlertResult {
  tenant: string;
  /** true si l'écart dépasse le seuil N jours consécutifs. */
  shouldAlert: boolean;
  /** nombre de jours consécutifs en dépassement à la fin de la série. */
  consecutiveBreaches: number;
  /** écart % du dernier jour observé. */
  latestDiffPct: number;
}

/**
 * Détermine s'il faut alerter pour un tenant.
 *
 * Règle (ticket D2 §Alerting) : écart > `thresholdPct` pendant
 * `consecutiveDays` jours consécutifs (par défaut 10 % / 3 jours).
 *
 * On compte la plus longue série de dépassements TERMINANT la série (les
 * jours les plus récents) : un écart résolu il y a 5 jours ne doit pas
 * déclencher d'alerte aujourd'hui.
 */
export function evaluateTenantAlert(
  series: TenantDiffSeries,
  opts: { thresholdPct?: number; consecutiveDays?: number } = {},
): AlertResult {
  const thresholdPct = opts.thresholdPct ?? 10;
  const consecutiveDays = opts.consecutiveDays ?? 3;

  // Points triés par date croissante — on parcourt depuis la fin.
  const sorted = [...series.points].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );

  let consecutive = 0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const pct = relativeDiffPct(sorted[i]);
    if (pct > thresholdPct) {
      consecutive++;
    } else {
      break; // série de dépassements terminée
    }
  }

  const latest = sorted.length > 0 ? sorted[sorted.length - 1] : null;
  return {
    tenant: series.tenant,
    shouldAlert: consecutive >= consecutiveDays,
    consecutiveBreaches: consecutive,
    latestDiffPct: latest ? relativeDiffPct(latest) : 0,
  };
}

/** Évalue tous les tenants et ne retourne que ceux à alerter. */
export function tenantsToAlert(
  allSeries: TenantDiffSeries[],
  opts?: { thresholdPct?: number; consecutiveDays?: number },
): AlertResult[] {
  return allSeries
    .map((s) => evaluateTenantAlert(s, opts))
    .filter((r) => r.shouldAlert);
}

/** Construit le message Telegram à partir des tenants en alerte. */
export function buildAlertMessage(alerts: AlertResult[]): string {
  if (alerts.length === 0) {
    return "Migration dual-tracking : tous les tenants sous le seuil de 10 %.";
  }
  const lines = [
    `🔴 Migration dual-tracking — ${alerts.length} tenant(s) en écart > 10 % :`,
  ];
  for (const a of alerts) {
    lines.push(
      `  • ${a.tenant} : ${a.latestDiffPct.toFixed(1)} % d'écart, ` +
        `${a.consecutiveBreaches} jour(s) consécutifs — NE PAS faire le cutover.`,
    );
  }
  return lines.join("\n");
}
