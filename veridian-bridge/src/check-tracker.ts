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
 * Helper : construit un `RecentActivityFetcher` qui interroge staminads via
 * /api/analytics.query. Utilisé par app.ts. La logique HTTP est isolée ici
 * pour pouvoir la mocker en test sans rejouer un faux serveur.
 *
 * On interroge avec la dimension `date` sur la fenêtre `last_24_hours` :
 *   - somme des `pageviews` de toutes les lignes → totalEvents24h
 *   - plus petite `date` non vide (pageviews > 0) → firstSeenAt
 *
 * staminads renvoie les dates au format `YYYY-MM-DD` (granularité jour). On
 * normalise en ISO en plaçant minuit UTC — c'est suffisant pour le wizard
 * qui n'affiche `firstSeenAt` qu'à titre indicatif.
 *
 * Tout échec staminads (workspace vide, query refusée) → activité nulle
 * plutôt qu'une exception : c'est l'état d'un site qui n'a jamais ingéré.
 */
export function makeStaminadsRecentActivityFetcher(opts: {
  staminadsUrl: string;
  getAdminToken: () => Promise<string>;
}): RecentActivityFetcher {
  return async (workspaceId: string): Promise<RecentActivity> => {
    let token: string;
    try {
      token = await opts.getAdminToken();
    } catch {
      return { totalEvents24h: 0, firstSeenAt: null };
    }

    let queryRes: globalThis.Response;
    try {
      queryRes = await fetch(`${opts.staminadsUrl}/api/analytics.query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          workspace_id: workspaceId,
          metrics: ["pageviews"],
          dimensions: ["date"],
          dateRange: { type: "last_24_hours" },
        }),
      });
    } catch {
      // staminads injoignable → on considère le tracker pas encore actif.
      return { totalEvents24h: 0, firstSeenAt: null };
    }

    if (!queryRes.ok) {
      return { totalEvents24h: 0, firstSeenAt: null };
    }

    let body: { rows?: Array<Record<string, unknown>> };
    try {
      body = (await queryRes.json()) as {
        rows?: Array<Record<string, unknown>>;
      };
    } catch {
      return { totalEvents24h: 0, firstSeenAt: null };
    }

    const rows = Array.isArray(body.rows) ? body.rows : [];
    let total = 0;
    let earliestDate: string | null = null;

    for (const row of rows) {
      const pvRaw = row["pageviews"];
      const pv =
        typeof pvRaw === "number"
          ? pvRaw
          : typeof pvRaw === "string"
            ? Number(pvRaw) || 0
            : 0;
      total += pv;

      if (pv > 0) {
        const dateRaw = row["date"];
        const date = typeof dateRaw === "string" ? dateRaw : null;
        if (date && (earliestDate === null || date < earliestDate)) {
          earliestDate = date;
        }
      }
    }

    return {
      totalEvents24h: total,
      firstSeenAt: toIsoOrNull(earliestDate),
    };
  };
}

/**
 * Normalise une date staminads (`YYYY-MM-DD` ou déjà ISO) en ISO 8601.
 * Retourne `null` si la valeur n'est pas parsable.
 */
function toIsoOrNull(date: string | null): string | null {
  if (!date) return null;
  // `YYYY-MM-DD` → on place minuit UTC pour avoir un ISO complet.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Date(`${date}T00:00:00.000Z`)
    : new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
