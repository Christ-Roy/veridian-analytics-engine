/**
 * Routes Express pour la feature GSC (A4).
 *
 * Module isolé : pas de modif à `app.ts`. Wirable via `registerGscRoutes(app, deps)`.
 *
 * Endpoints :
 *   - POST /api/admin/gsc/oauth-begin?tenantId=...
 *   - GET  /api/admin/gsc/oauth-callback?code=...&state=...
 *   - POST /api/admin/gsc/sync?gscPropertyId=...&days=30
 *   - POST /api/admin/gsc/sync-all              (Bearer admin OR IP allowlist)
 *   - GET  /api/admin/tenant/:workspaceId/gsc?days=30
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  oauthBeginFlow,
  oauthCallback,
  syncProperty,
  syncAllVerified,
  dashboardSummary,
  OauthConfigError,
  OauthFlowError,
  type OauthConfig,
} from "./index.js";

export interface GscRoutesDeps {
  prisma: PrismaClient;
  oauthConfig: OauthConfig;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  adminApiKey: string;
  dashboardRedirectUrl?: string;
  cronAllowedIps?: string[];
  fetchImpl?: typeof fetch;
}

export function registerGscRoutes(app: Express, deps: GscRoutesDeps): void {
  app.post(
    "/api/admin/gsc/oauth-begin",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const tenantId =
        typeof req.query.tenantId === "string" ? req.query.tenantId : "";
      if (!tenantId) {
        res.status(400).json({ error: "missing_tenant_id" });
        return;
      }
      try {
        const tenant = await deps.prisma.tenant.findUnique({
          where: { id: tenantId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const { url, state } = oauthBeginFlow(tenantId, deps.oauthConfig);
        res.json({ url, state, tenantId });
      } catch (err) {
        if (err instanceof OauthConfigError) {
          res
            .status(503)
            .json({ error: "gsc_not_configured", message: err.message });
          return;
        }
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  app.get(
    "/api/admin/gsc/oauth-callback",
    async (req: Request, res: Response) => {
      const code = typeof req.query.code === "string" ? req.query.code : "";
      const state = typeof req.query.state === "string" ? req.query.state : "";
      if (!code || !state) {
        res.status(400).json({ error: "missing_code_or_state" });
        return;
      }
      try {
        const { tenantId } = await oauthCallback(
          deps.prisma,
          code,
          state,
          deps.oauthConfig,
          deps.fetchImpl,
        );
        const redirect = deps.dashboardRedirectUrl;
        if (redirect) {
          const url = new URL(redirect);
          url.searchParams.set("tenantId", tenantId);
          url.searchParams.set("gsc", "connected");
          res.redirect(302, url.toString());
          return;
        }
        res.json({ ok: true, tenantId });
      } catch (err) {
        if (err instanceof OauthFlowError) {
          res
            .status(err.status ?? 400)
            .json({ error: "oauth_flow_error", message: err.message });
          return;
        }
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  app.post(
    "/api/admin/gsc/sync",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const gscPropertyId =
        typeof req.query.gscPropertyId === "string"
          ? req.query.gscPropertyId
          : "";
      if (!gscPropertyId) {
        res.status(400).json({ error: "missing_gsc_property_id" });
        return;
      }
      const daysRaw =
        typeof req.query.days === "string" ? Number(req.query.days) : 30;
      const days =
        Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? daysRaw : 30;
      try {
        const result = await syncProperty(deps.prisma, gscPropertyId, {
          days,
          oauthConfig: deps.oauthConfig,
          fetchImpl: deps.fetchImpl,
        });
        res.json({ ok: true, ...result });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  app.post("/api/admin/gsc/sync-all", async (req: Request, res: Response) => {
    const auth = req.header("authorization");
    const bearerOk =
      auth?.startsWith("Bearer ") &&
      auth.slice("Bearer ".length).trim() === deps.adminApiKey;
    const remoteIp = (req.ip || req.socket.remoteAddress || "").replace(
      /^::ffff:/,
      "",
    );
    const ipOk =
      Array.isArray(deps.cronAllowedIps) &&
      deps.cronAllowedIps.length > 0 &&
      deps.cronAllowedIps.includes(remoteIp);
    if (!bearerOk && !ipOk) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    try {
      const results = await syncAllVerified(deps.prisma, {
        days: 7,
        oauthConfig: deps.oauthConfig,
        fetchImpl: deps.fetchImpl,
      });
      res.json({ ok: true, count: results.length, results });
    } catch (err) {
      res
        .status(500)
        .json({ error: "internal", message: (err as Error).message });
    }
  });

  app.get(
    "/api/admin/tenant/:workspaceId/gsc",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const workspaceId = req.params.workspaceId;
      if (!workspaceId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      const daysRaw =
        typeof req.query.days === "string" ? Number(req.query.days) : 30;
      const days =
        Number.isFinite(daysRaw) && daysRaw > 0 && daysRaw <= 90 ? daysRaw : 30;
      try {
        const summary = await dashboardSummary(deps.prisma, {
          workspaceId,
          days,
        });
        res.json({ workspaceId, days, ...summary });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );
}
