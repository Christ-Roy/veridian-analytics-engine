/**
 * Routes Express pour la feature VoIP (B-VOIP).
 *
 * Module isolé style A4/B2 — pas de modif à `app.ts`. Wirable via
 * `registerVoipRoutes(app, deps)`.
 *
 * Endpoints ADMIN :
 *   - POST /api/admin/voip/sync?tenantId=...        — force resync d'un tenant
 *   - POST /api/admin/voip/sync-all                 — cron (Bearer OU IP allowlist)
 *   - GET  /api/admin/tenant/:workspaceId/calls?days=30 — liste des appels (tab Calls)
 *
 * La saisie / le test / la suppression des credentials VoIP sont gérés par
 * U8 (page Settings + endpoints `/api/admin/tenant/:wsId/credentials*`).
 * B-VOIP ne fait QUE pull les CDR et servir le tab Calls — il ne duplique pas
 * le CRUD des creds.
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { syncCallLogs, syncAllCallLogs } from "./sync.js";
import { listCalls } from "./query.js";

export interface VoipRoutesDeps {
  prisma: PrismaClient;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  /** clé Bearer admin — sert au fallback du cron `sync-all`. */
  adminApiKey: string;
  /** clé hex AES-256-GCM (`TOKEN_ENCRYPTION_KEY`). */
  encryptionKey: string;
  /** IPs autorisées à appeler `sync-all` sans Bearer (cron). */
  cronAllowedIps?: string[];
  /** injection de fetch pour les tests. */
  fetchImpl?: typeof fetch;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function clampDays(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : 30;
  return Number.isFinite(n) && n > 0 && n <= 365 ? n : 30;
}

// ─── Register ─────────────────────────────────────────────────────────────

export function registerVoipRoutes(app: Express, deps: VoipRoutesDeps): void {
  // ── POST /api/admin/voip/sync?tenantId=... ────────────────────────────────
  // `tenantId` accepte l'id interne OU le workspaceId (la page Settings ne
  // connaît que le workspaceId).
  app.post(
    "/api/admin/voip/sync",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const tenantIdRaw =
        typeof req.query.tenantId === "string" ? req.query.tenantId : "";
      if (!tenantIdRaw) {
        res.status(400).json({ error: "missing_tenant_id" });
        return;
      }
      try {
        // Accepte id interne ou workspaceId.
        let tenant = await deps.prisma.tenant.findUnique({
          where: { id: tenantIdRaw },
          select: { id: true },
        });
        if (!tenant) {
          tenant = await deps.prisma.tenant.findUnique({
            where: { workspaceId: tenantIdRaw },
            select: { id: true },
          });
        }
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const days = clampDays(req.query.days);
        const result = await syncCallLogs(deps.prisma, tenant.id, {
          days,
          encryptionKey: deps.encryptionKey,
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

  // ── POST /api/admin/voip/sync-all ─────────────────────────────────────────
  // Cron : Bearer admin OU IP allowlist (cohérent avec GSC sync-all).
  app.post("/api/admin/voip/sync-all", async (req: Request, res: Response) => {
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
      const days = clampDays(req.query.days);
      const results = await syncAllCallLogs(deps.prisma, {
        days,
        encryptionKey: deps.encryptionKey,
        fetchImpl: deps.fetchImpl,
      });
      const totalUpserted = results.reduce(
        (acc, r) => acc + r.totalUpserted,
        0,
      );
      res.json({
        ok: true,
        count: results.length,
        totalUpserted,
        results,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: "internal", message: (err as Error).message });
    }
  });

  // ── GET /api/admin/tenant/:workspaceId/calls?days=30 ─────────────────────
  app.get(
    "/api/admin/tenant/:workspaceId/calls",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const workspaceId =
        typeof req.params.workspaceId === "string"
          ? req.params.workspaceId
          : "";
      if (!workspaceId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      const days = clampDays(req.query.days);
      const limitRaw =
        typeof req.query.limit === "string" ? Number(req.query.limit) : 200;
      const limit =
        Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 200;
      try {
        const summary = await listCalls(deps.prisma, {
          workspaceId,
          days,
          limit,
        });
        if (!summary) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        res.json({ workspaceId, days, ...summary });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );
}
