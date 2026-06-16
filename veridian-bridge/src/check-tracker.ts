/**
 * GET /api/admin/tenant/:workspaceId/check-tracker
 *
 * Endpoint utilisé par l'onboarding wizard `/welcome` côté console (ticket
 * U4 / ex-C3) : pendant que le nouveau tenant colle le snippet sur son site,
 * le wizard poll cet endpoint toutes les 5s pour détecter le premier
 * pageview reçu.
 *
 * Réponse :
 *   {
 *     "status": "ok" | "waiting",
 *     "firstSeenAt": "2026-05-22T14:23:11Z" | null,
 *     "totalEvents24h": number
 *   }
 *
 *   - `status: 'waiting'` → aucun event reçu sur la fenêtre récente.
 *   - `status: 'ok'`      → au moins un pageview reçu ; le wizard redirige.
 *   - `firstSeenAt`       → horodatage du premier event détecté (best-effort
 *     dérivé de la dimension `date` staminads) ou `null` si on attend encore.
 *
 * Pourquoi une factory (createCheckTrackerHandler) :
 *   - L'endpoint réel injecte un `fetchRecentActivity` qui interroge staminads
 *     via /api/analytics.query (admin token déjà câblé dans app.ts).
 *   - Les tests injectent un fake `fetchRecentActivity` pour piloter les
 *     counts sans monter un faux serveur HTTP (plus rapide, déterministe).
 */

import type { Request, Response } from "express";

/** Résultat brut de l'activité récente d'un workspace staminads. */
export interface RecentActivity {
  /** Nombre de pageviews sur la fenêtre récente (≈ 24h glissantes). */
  totalEvents24h: number;
  /**
   * Horodatage ISO du premier event détecté sur la fenêtre, ou `null` si
   * aucun event (workspace tout neuf qui n'a jamais ingéré). Best-effort :
   * dérivé de la dimension `date` staminads (granularité jour).
   */
  firstSeenAt: string | null;
}

export type RecentActivityFetcher = (
  workspaceId: string,
) => Promise<RecentActivity>;

export interface CheckTrackerResponse {
  status: "ok" | "waiting";
  firstSeenAt: string | null;
  totalEvents24h: number;
}

/**
 * Construit un handler Express pour `check-tracker`. `requireVeridianAdmin`
 * est appliqué en amont dans app.ts (comme les autres routes /api/admin/*).
 */
export function createCheckTrackerHandler(deps: {
  fetchRecentActivity: RecentActivityFetcher;
}) {
  return async (req: Request, res: Response): Promise<void> => {
    const rawId = req.params.workspaceId;
    // Express 5 type Params : string | string[]. Sur une route avec un
    // simple :workspaceId on n'a jamais un array, mais TS l'exige.
    const workspaceId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!workspaceId || workspaceId.length === 0) {
      res.status(400).json({ error: "missing_workspace_id" });
      return;
    }

    try {
      const activity = await deps.fetchRecentActivity(workspaceId);
      const status: CheckTrackerResponse["status"] =
        activity.totalEvents24h > 0 ? "ok" : "waiting";
      const body: CheckTrackerResponse = {
        status,
        firstSeenAt: status === "ok" ? activity.firstSeenAt : null,
        totalEvents24h: activity.totalEvents24h,
      };
      res.json(body);
    } catch (err) {
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  };
}

/**
 * Capacité minimale dont ce module a besoin du client Engine M2M : lancer une
 * query analytics native. Interface étroite pour que les tests mockent juste
 * `analyticsQuery`.
 */
export interface EngineAnalyticsQuerier {
  analyticsQuery(input: {
    workspace_id: string;
    metrics: string[];
    dimensions?: string[];
    dateRange: { preset?: string; start?: string; end?: string };
    table?: "sessions" | "pages" | "goals";
  }): Promise<{ data: Array<Record<string, unknown>> }>;
}

/**
 * Helper : construit un `RecentActivityFetcher` qui interroge l'Engine via le
 * client M2M natif (`/api/admin/platform/analytics.query`, Bearer
 * PLATFORM_ADMIN_API_KEY). Utilisé par app.ts. Logique isolée pour pouvoir la
 * mocker en test sans rejouer un faux serveur.
 *
 * On interroge `page_count` (table `pages`) sur le preset natif `today` (le
 * contrat natif n'a PAS de fenêtre `last_24_hours` glissante ni de dimension
 * `date` — `today` couvre le besoin onboarding "le tracker a-t-il commencé à
 * émettre ?"). ⚠️ PAS la métrique `pageviews` (countIf(name=...) qui casse :
 * colonne `name` absente des tables analytiques) — `page_count` = `count()`
 * sur `pages` est la vraie métrique câblée :
 *   - somme des `page_count` → totalEvents24h
 *   - `firstSeenAt` = horodatage de détection (now) dès qu'un event est vu.
 *     Le wizard ne l'affiche qu'à titre indicatif ; le natif day-dimension
 *     est un nombre (jour du mois), pas une date reconstructible — on assume
 *     un firstSeenAt approximatif côté détection plutôt qu'un bricolage.
 *
 * Tout échec Engine (workspace vide, query refusée, injoignable) → activité
 * nulle plutôt qu'une exception : c'est l'état d'un site qui n'a jamais ingéré.
 */
export function makeStaminadsRecentActivityFetcher(opts: {
  engine: EngineAnalyticsQuerier;
}): RecentActivityFetcher {
  return async (workspaceId: string): Promise<RecentActivity> => {
    let data: Array<Record<string, unknown>>;
    try {
      const res = await opts.engine.analyticsQuery({
        workspace_id: workspaceId,
        metrics: ["page_count"],
        dimensions: [],
        dateRange: { preset: "today" },
        table: "pages",
      });
      data = res.data ?? [];
    } catch {
      // Engine injoignable / query refusée → tracker pas encore actif.
      return { totalEvents24h: 0, firstSeenAt: null };
    }

    let total = 0;
    for (const row of data) {
      const pvRaw = row["page_count"];
      const pv =
        typeof pvRaw === "number"
          ? pvRaw
          : typeof pvRaw === "string"
            ? Number(pvRaw) || 0
            : 0;
      total += pv;
    }

    return {
      totalEvents24h: total,
      firstSeenAt: total > 0 ? new Date().toISOString() : null,
    };
  };
}
