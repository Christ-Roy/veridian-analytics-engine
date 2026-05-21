/**
 * Routes Express pour les Push Notifications (B2).
 *
 * Module isolé style A4 — pas de modif à `app.ts`. Wirable via
 * `registerPushRoutes(app, deps)`.
 *
 * Endpoints PUBLIC :
 *   - POST /api/push/subscribe        — enregistre un browser
 *   - POST /api/push/unsubscribe      — marque active=false
 *   - GET  /api/push/vapid-key        — clé publique VAPID (CORS *)
 *
 * Endpoints ADMIN (Bearer) :
 *   - POST /api/admin/push/send                              — broadcast tenant
 *   - GET  /api/admin/tenant/:workspaceId/push/subscribers   — liste + count
 *   - GET  /api/admin/tenant/:workspaceId/push/history       — historique notifs
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  subscribePushClient,
  unsubscribePushClient,
  sendNotificationToTenant,
  getVapidPublicKey,
  listSubscribers,
  listNotificationHistory,
} from "./index.js";

export interface PushRoutesDeps {
  prisma: PrismaClient;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
}

// ─── Schemas Zod ──────────────────────────────────────────────────────────

const SubscribeSchema = z.object({
  // workspaceId staminads (= identifiant public connu côté snippet tracker)
  workspaceId: z.string().min(1).max(64),
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  siteId: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
  visitorId: z.string().max(128).optional(),
});

const UnsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

const SendSchema = z.object({
  tenantId: z.string().min(1),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(1000),
  url: z.string().url().optional(),
  icon: z.string().url().optional(),
  tag: z.string().max(100).optional(),
  sentBy: z.string().max(128).optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function setPublicCors(res: Response): void {
  // Subscribe/vapid-key sont appelés depuis les sites clients (cross-origin)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
}

// ─── Register ────────────────────────────────────────────────────────────

export function registerPushRoutes(app: Express, deps: PushRoutesDeps): void {
  // ── GET /api/push/vapid-key ─────────────────────────────────────────────
  app.get("/api/push/vapid-key", (_req: Request, res: Response) => {
    setPublicCors(res);
    const publicKey = getVapidPublicKey();
    res.json({ publicKey });
  });

  // OPTIONS preflight pour subscribe/unsubscribe/vapid-key
  app.options("/api/push/:rest", (_req, res) => {
    setPublicCors(res);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
  });

  // ── POST /api/push/subscribe ───────────────────────────────────────────
  app.post("/api/push/subscribe", async (req: Request, res: Response) => {
    setPublicCors(res);
    const parsed = SubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_payload",
        issues: parsed.error.flatten(),
      });
      return;
    }
    try {
      const tenant = await deps.prisma.tenant.findUnique({
        where: { workspaceId: parsed.data.workspaceId },
      });
      if (!tenant) {
        res.status(404).json({ error: "tenant_not_found" });
        return;
      }
      const result = await subscribePushClient(deps.prisma, tenant.id, {
        endpoint: parsed.data.endpoint,
        keys: parsed.data.keys,
        siteId: parsed.data.siteId,
        userAgent: parsed.data.userAgent ?? req.header("user-agent") ?? undefined,
        visitorId: parsed.data.visitorId,
      });
      res.status(result.created ? 201 : 200).json({
        ok: true,
        id: result.id,
        created: result.created,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: "internal", message: (err as Error).message });
    }
  });

  // ── POST /api/push/unsubscribe ─────────────────────────────────────────
  app.post("/api/push/unsubscribe", async (req: Request, res: Response) => {
    setPublicCors(res);
    const parsed = UnsubscribeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_payload",
        issues: parsed.error.flatten(),
      });
      return;
    }
    try {
      const result = await unsubscribePushClient(
        deps.prisma,
        parsed.data.endpoint,
      );
      res.json({ ok: true, updated: result.updated });
    } catch (err) {
      res
        .status(500)
        .json({ error: "internal", message: (err as Error).message });
    }
  });

  // ── POST /api/admin/push/send ──────────────────────────────────────────
  app.post(
    "/api/admin/push/send",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const parsed = SendSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_payload",
          issues: parsed.error.flatten(),
        });
        return;
      }
      try {
        const result = await sendNotificationToTenant(
          deps.prisma,
          parsed.data.tenantId,
          {
            title: parsed.data.title,
            body: parsed.data.body,
            url: parsed.data.url,
            icon: parsed.data.icon,
            tag: parsed.data.tag,
            sentBy: parsed.data.sentBy,
          },
        );
        res.json({ ok: true, ...result });
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.startsWith("tenant_not_found")) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        res.status(500).json({ error: "internal", message: msg });
      }
    },
  );

  // ── GET /api/admin/tenant/:workspaceId/push/subscribers ────────────────
  app.get(
    "/api/admin/tenant/:workspaceId/push/subscribers",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const workspaceIdRaw = req.params.workspaceId;
      const workspaceId =
        typeof workspaceIdRaw === "string" ? workspaceIdRaw : "";
      if (!workspaceId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      try {
        const tenant = await deps.prisma.tenant.findUnique({
          where: { workspaceId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const summary = await listSubscribers(deps.prisma, tenant.id);
        res.json({ workspaceId, ...summary });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  // ── GET /api/admin/tenant/:workspaceId/push/history ────────────────────
  app.get(
    "/api/admin/tenant/:workspaceId/push/history",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const workspaceIdRaw = req.params.workspaceId;
      const workspaceId =
        typeof workspaceIdRaw === "string" ? workspaceIdRaw : "";
      if (!workspaceId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      try {
        const tenant = await deps.prisma.tenant.findUnique({
          where: { workspaceId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const history = await listNotificationHistory(deps.prisma, tenant.id);
        res.json({ workspaceId, count: history.length, notifications: history });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );
}
