/**
 * Port du `buildTenantStatus()` legacy (veridian-analytics/lib/tenant-status.ts)
 * adapté au bridge → staminads.
 *
 * V1 (sprint A2) :
 *   - `pageviews` lu depuis staminads (analytics.query, preset `last_30_days`).
 *   - `forms` (B1), `calls`, `gsc` (A4), `ads`, `pagespeed` : 0, retournés
 *     inactifs avec TODO. Les counts gsc sont exposés pour rester rétro-compat
 *     avec le shape legacy mais valent 0 tant que la sync GSC (A4) n'est pas
 *     branchée.
 *
 * Pourquoi une factory (createTenantStatusBuilder) :
 *   - L'endpoint réel injecte un client `analyticsQuery` qui parle au staminads
 *     pointé par cfg.staminadsUrl avec un admin token déjà câblé dans app.ts.
 *   - Les tests injectent un fake `analyticsQuery` pour piloter les counts sans
 *     dépendre du fake-staminads HTTP (plus rapide, plus déterministe).
 *
 * L'ordre des services dans KNOWN_SERVICES est canonique (alimente l'UI :
 * shadow marketing + dashboard root) — ne pas réordonner sans coordonner avec
 * A3 / C2.
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

export interface GscPropertySummary {
  propertyUrl: string;
  lastSyncAt: string | null;
}

export interface SiteStatus {
  workspaceId: string;
  activeServices: ServiceKey[];
  inactiveServices: ServiceKey[];
  counts: {
    pageviews: number;
    forms: number;
    calls: number;
    gscRows: number;
    gscClicks: number;
    gscImpressions: number;
    gscProperty: GscPropertySummary | null;
  };
}

/**
 * Interroge staminads pour obtenir le nombre de pageviews sur la fenêtre 30j
 * d'un workspace. Retourne 0 si la query échoue ou ne renvoie aucune ligne
 * (un workspace tout neuf qui n'a jamais reçu d'event = pas d'erreur, juste
 * 0 pageview).
 */
export type PageviewsFetcher = (workspaceId: string) => Promise<number>;

export interface TenantStatusDeps {
  fetchPageviews30d: PageviewsFetcher;
}

export interface TenantStatusBuilder {
  build(workspaceId: string): Promise<SiteStatus>;
}

export function createTenantStatusBuilder(
  deps: TenantStatusDeps,
): TenantStatusBuilder {
  return {
    async build(workspaceId: string): Promise<SiteStatus> {
      const pageviews = await deps.fetchPageviews30d(workspaceId);

      // V1 : seul pageviews lit la vraie data. Les autres services sont câblés
      // en dur à 0 + restent inactifs jusqu'à ce que les tickets dédiés
      // (B1 forms, A4 gsc) livrent leur source de vérité.
      // TODO(B1)         : remplacer 0 par count form_submissions / sip_calls
      //                    quand l'ingestion forms sera live (sprint 2026-05-22 B1).
      // TODO(A4)         : remplacer 0 par count gsc_daily + agrégat clicks/impressions
      //                    + lookup gscProperty quand la sync GSC sera portée (A4).
      // TODO(ads)        : Google Ads — service payant futur, pas de capteur côté engine.
      // TODO(pagespeed)  : monitoring PageSpeed hebdo — service payant futur.
      const counts: SiteStatus["counts"] = {
        pageviews,
        forms: 0,
        calls: 0,
        gscRows: 0,
        gscClicks: 0,
        gscImpressions: 0,
        gscProperty: null,
      };

      const activeServices: ServiceKey[] = [];
      if (counts.pageviews > 0) activeServices.push("pageviews");
      // forms / calls / ads / pagespeed : V1 toujours inactifs.
      // gsc : actif si propriété branchée ET rows > 0 (cf legacy detectServices).
      if (counts.gscProperty && counts.gscRows > 0) activeServices.push("gsc");

      const inactiveServices = KNOWN_SERVICES.filter(
        (s) => !activeServices.includes(s),
      );

      return {
        workspaceId,
        activeServices,
        inactiveServices,
        counts,
      };
    },
  };
}

/**
 * Helper : construit un PageviewsFetcher qui interroge staminads via
 * /api/analytics.query. Utilisé par app.ts. Garde la logique HTTP isolée
 * pour pouvoir la mocker en test sans rejouer un faux serveur.
 *
 * staminads renvoie soit `{ rows: [{ pageviews: number, ... }, ...] }` soit
 * un format avec dimensions (rows agrégées). Sans dimensions, la query
 * retourne UNE ligne avec la métrique globale. On somme par sécurité au cas
 * où plusieurs lignes seraient renvoyées (futur).
 */
export function makeStaminadsPageviewsFetcher(opts: {
  staminadsUrl: string;
  getAdminToken: () => Promise<string>;
}): PageviewsFetcher {
  return async (workspaceId: string) => {
    const token = await opts.getAdminToken();
    const res = await fetch(`${opts.staminadsUrl}/api/analytics.query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        metrics: ["pageviews"],
        dimensions: [],
        dateRange: { preset: "last_30_days" },
      }),
    });
    if (!res.ok) {
      // Workspace vide ou query refusée → on retourne 0 plutôt que de planter
      // l'endpoint tenant-status, c'est l'état d'un site qui n'a jamais ingéré.
      return 0;
    }
    const body = (await res.json()) as {
      rows?: Array<Record<string, unknown>>;
    };
    if (!body.rows || body.rows.length === 0) return 0;
    let total = 0;
    for (const row of body.rows) {
      const pv = row["pageviews"];
      if (typeof pv === "number") total += pv;
      else if (typeof pv === "string") total += Number(pv) || 0;
    }
    return total;
  };
}
