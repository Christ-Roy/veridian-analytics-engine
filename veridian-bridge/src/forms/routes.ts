/**
 * Routes Express pour la feature Forms (B1).
 *
 * Module isolé style A4 : pas de modif lourde de `app.ts`, on registre
 * via `registerFormsRoutes(app, deps)`.
 *
 * Endpoints :
 *   - POST /api/ingest/form                      (PUBLIC, rate-limited)
 *   - GET  /api/admin/tenant/:workspaceId/forms  (Bearer admin)
 *   - GET  /api/admin/lead/:leadId               (Bearer admin)
 *
 * Le POST public est volontairement ouvert (CORS) : c'est appelé depuis le
 * navigateur du visiteur sur les sites clients. L'auth est portée par le
 * couple (siteKey + rate limit IP).
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import {
  IngestFormSchema,
  ListSubmissionsFiltersSchema,
} from "./types.js";
import {
  ingestFormSubmission,
  SiteKeyNotFoundError,
} from "./ingest.js";
import {
  getLeadDetails,
  LeadNotFoundError,
  listSubmissions,
  TenantNotFoundError,
} from "./query.js";
import { createRateLimiter, type RateLimiter } from "./rate-limit.js";

export interface FormsRoutesDeps {
  prisma: PrismaClient;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  staminadsUrl?: string;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Override rate limiter (tests — bumping max/window). */
  rateLimiter?: RateLimiter;
}

/**
 * Extrait l'IP client depuis les headers (CF → X-Forwarded-For → remoteAddress).
 * Cohérent avec lib/ingest.ts legacy.
 */
export function getClientIp(req: Request): string {
  const cf = req.header("cf-connecting-ip");
  if (cf) return cf;
  const xff = req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  const xri = req.header("x-real-ip");
  if (xri) return xri;
  return (req.ip || req.socket.remoteAddress || "unknown").replace(/^::ffff:/, "");
}

function corsHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export function registerFormsRoutes(app: Express, deps: FormsRoutesDeps): void {
  const limiter =
    deps.rateLimiter ?? createRateLimiter({ windowMs: 60_000, max: 10 });

  app.options("/api/ingest/form", (_req, res) => {
    corsHeaders(res);
    res.status(204).end();
  });

  app.post("/api/ingest/form", async (req: Request, res: Response) => {
    corsHeaders(res);

    const ip = getClientIp(req);
    if (ip !== "unknown" && !limiter.check(ip)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "rate_limited", retryAfterSec: 60 });
      return;
    }

    const parsed = IngestFormSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await ingestFormSubmission(
        {
          prisma: deps.prisma,
          staminadsUrl: deps.staminadsUrl,
          fetchImpl: deps.fetchImpl,
        },
        parsed.data,
        {
          ipAddress: ip === "unknown" ? null : ip,
          userAgent: req.header("user-agent") ?? null,
        },
      );
      res.json({
        ok: true,
        submissionId: result.submissionId,
        leadId: result.leadId,
        leadCreated: result.leadCreated,
      });
    } catch (err) {
      if (err instanceof SiteKeyNotFoundError) {
        res.status(401).json({ error: "invalid_site_key" });
        return;
      }
      res
        .status(500)
        .json({ error: "internal", message: (err as Error).message });
    }
  });

  app.get(
    "/api/admin/tenant/:workspaceId/forms",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const rawId = req.params.workspaceId;
      const workspaceId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!workspaceId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      const parsed = ListSubmissionsFiltersSchema.safeParse({
        formSlug: req.query.formSlug,
        since: req.query.since,
        until: req.query.until,
        limit: req.query.limit,
        cursor: req.query.cursor,
      });
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_query",
          details: parsed.error.flatten(),
        });
        return;
      }
      try {
        const result = await listSubmissions(
          deps.prisma,
          workspaceId,
          parsed.data,
        );
        res.json({ workspaceId, ...result });
      } catch (err) {
        if (err instanceof TenantNotFoundError) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  app.get(
    "/api/admin/lead/:leadId",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const rawId = req.params.leadId;
      const leadId = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!leadId) {
        res.status(400).json({ error: "missing_lead_id" });
        return;
      }
      try {
        const details = await getLeadDetails(deps.prisma, leadId);
        res.json(details);
      } catch (err) {
        if (err instanceof LeadNotFoundError) {
          res.status(404).json({ error: "lead_not_found" });
          return;
        }
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );
}
