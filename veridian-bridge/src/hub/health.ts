/**
 * GET /api/tenants/:id/health — endpoint Hub HMAC.
 *
 * Source : CONTRAT-HUB §5.5.
 *
 * Renvoie l'état lifecycle du tenant + quelques métriques d'usage :
 *   - status            : active | suspended | soft_deleted | trial_expired
 *   - last_event_at     : dernier pageview reçu (ISO8601 ou null)
 *   - sites_count       : nombre de propriétés GSC attachées
 *   - pageviews_30d     : pageviews sur les 30 derniers jours
 *   - owner_attached    : true si ownerEmail + ownerUserId présents
 *   - magic_link_capable: true si owner attaché ET status=active
 *   - api_key_valid     : true si apiKey présente
 *
 * En V1 : lit les colonnes du Tenant. Les stats (pageviews_30d, last_event_at)
 * sont remplies par un hook optionnel `loadStats` injecté côté factory (qui
 * appellera staminads /analytics.query plus tard). Si absent, on renvoie 0/null.
 */

import type { Request, Response } from "express";
import type { TenantStore, TenantRecord } from "./store.js";

export interface HealthStats {
  lastEventAt: Date | null;
  sitesCount: number;
  pageviews30d: number;
}

export interface HealthDeps {
  store: TenantStore;
  /** Hook optionnel pour récupérer les métriques live depuis staminads. */
  loadStats?(tenant: TenantRecord): Promise<HealthStats>;
}

export function healthHandler(deps: HealthDeps) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const rawId = req.params.id;
    const tenantId = Array.isArray(rawId) ? rawId[0] : rawId;
    if (!tenantId || tenantId.length === 0) {
      res.status(400).json({
        error: "invalid_request",
        error_code: "missing_tenant_id",
      });
      return;
    }

    try {
      const tenant = await deps.store.findByHubTenantId(tenantId);
      if (!tenant) {
        res.status(404).json({
          error: "tenant_not_found",
          error_code: "tenant_not_found",
        });
        return;
      }

      let stats: HealthStats;
      if (deps.loadStats) {
        stats = await deps.loadStats(tenant);
      } else {
        stats = {
          lastEventAt: tenant.lastEventAt ?? null,
          sitesCount: tenant.sitesCount ?? 0,
          pageviews30d: tenant.pageviews30d ?? 0,
        };
      }

      const ownerAttached = Boolean(tenant.ownerEmail && tenant.ownerUserId);

      res.json({
        tenant_id: tenant.hubTenantId,
        workspace_id: tenant.workspaceId,
        status: tenant.status,
        owner_attached: ownerAttached,
        owner_email: tenant.ownerEmail,
        owner_user_id: tenant.ownerUserId,
        api_key_valid: Boolean(tenant.apiKey),
        magic_link_capable: ownerAttached && tenant.status === "active",
        plan: tenant.plan,
        last_event_at: stats.lastEventAt
          ? stats.lastEventAt.toISOString()
          : null,
        sites_count: stats.sitesCount,
        pageviews_30d: stats.pageviews30d,
        checked_at: new Date().toISOString(),
      });
    } catch (err) {
      res.status(500).json({
        error: "internal",
        message: (err as Error).message,
      });
    }
  };
}
