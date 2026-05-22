/**
 * Routes Express — page Settings tenant + credentials self-service (U8).
 *
 * Module isolé style A4/B2 — pas de modif à `app.ts`. Wirable via
 * `registerSettingsRoutes(app, deps)`.
 *
 * Tous les endpoints sont ADMIN (Bearer) — la console les appelle avec la
 * clé admin du bridge. Le `:wsId` est le `workspaceId` staminads du tenant.
 *
 * Endpoints :
 *   - GET    /api/admin/tenant/:wsId/settings
 *   - PUT    /api/admin/tenant/:wsId/settings
 *   - GET    /api/admin/tenant/:wsId/credentials
 *   - POST   /api/admin/tenant/:wsId/credentials
 *   - POST   /api/admin/tenant/:wsId/credentials/:kind/test
 *   - DELETE /api/admin/tenant/:wsId/credentials/:kind
 *
 * Sécurité :
 *   - Bearer admin sur toutes les routes (`deps.requireAdmin`)
 *   - Les creds VoIP ne sont JAMAIS renvoyés en clair — la couche store ne
 *     sert que des vues masquées (`••••1234`)
 *   - Les creds sont chiffrés AES-256-GCM avant écriture en DB
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  getTenantSettings,
  updateTenantSettings,
  SettingsError,
} from "./store.js";
import {
  saveCredential,
  testCredential,
  deleteCredential,
  CredentialError,
} from "../credentials/store.js";

export interface SettingsRoutesDeps {
  prisma: PrismaClient;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  /** Clé AES-256-GCM (64 hex) — `TOKEN_ENCRYPTION_KEY`, partagée avec GSC. */
  encryptionKey: string;
  /** Override fetch pour les tests de connexion provider (mock). */
  fetchImpl?: typeof fetch;
}

// ─── Schemas Zod ────────────────────────────────────────────────────────────

const SettingsUpdateSchema = z
  .object({
    notifyNewLead: z.boolean().optional(),
    notifyWeeklyReport: z.boolean().optional(),
    notifyEmail: z.string().email().max(254).nullable().optional(),
    pushAdminEnabled: z.boolean().optional(),
    visitorIdEnabled: z.boolean().optional(),
    cookieConsentEnabled: z.boolean().optional(),
  })
  .strict();

const CredentialBodySchema = z.object({
  kind: z.string().min(1).max(64),
  // `creds` est validé finement par le provider (cf credentials/store.ts).
  creds: z.record(z.unknown()),
});

// ─── Register ───────────────────────────────────────────────────────────────

export function registerSettingsRoutes(
  app: Express,
  deps: SettingsRoutesDeps,
): void {
  const { prisma, requireAdmin, encryptionKey } = deps;

  /** Extrait `:wsId` proprement (express 5 type Params : string | string[]). */
  function wsIdOf(req: Request): string {
    const raw = req.params.wsId;
    return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
  }

  /** Mappe les erreurs métier sur des codes HTTP propres. */
  function sendError(res: Response, err: unknown): void {
    if (err instanceof SettingsError) {
      const status = err.code === "tenant_not_found" ? 404 : 400;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    if (err instanceof CredentialError) {
      const status =
        err.code === "tenant_not_found" || err.code === "credential_not_found"
          ? 404
          : 400;
      res.status(status).json({ error: err.code, message: err.message });
      return;
    }
    res.status(500).json({ error: "internal", message: (err as Error).message });
  }

  // ── GET /api/admin/tenant/:wsId/settings ────────────────────────────────
  app.get(
    "/api/admin/tenant/:wsId/settings",
    requireAdmin,
    async (req: Request, res: Response) => {
      const wsId = wsIdOf(req);
      if (!wsId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      try {
        const view = await getTenantSettings(prisma, wsId, encryptionKey);
        res.json(view);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // ── PUT /api/admin/tenant/:wsId/settings ────────────────────────────────
  app.put(
    "/api/admin/tenant/:wsId/settings",
    requireAdmin,
    async (req: Request, res: Response) => {
      const wsId = wsIdOf(req);
      if (!wsId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      const parsed = SettingsUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "invalid_payload", issues: parsed.error.flatten() });
        return;
      }
      try {
        const view = await updateTenantSettings(
          prisma,
          wsId,
          parsed.data,
          encryptionKey,
        );
        res.json(view);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // ── GET /api/admin/tenant/:wsId/credentials ─────────────────────────────
  // Liste masquée — pratique pour le polling de statut côté UI.
  app.get(
    "/api/admin/tenant/:wsId/credentials",
    requireAdmin,
    async (req: Request, res: Response) => {
      const wsId = wsIdOf(req);
      if (!wsId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { workspaceId: wsId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const { listCredentials } = await import("../credentials/store.js");
        const creds = await listCredentials(prisma, tenant.id, encryptionKey);
        res.json({ workspaceId: wsId, credentials: creds });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // ── POST /api/admin/tenant/:wsId/credentials ────────────────────────────
  app.post(
    "/api/admin/tenant/:wsId/credentials",
    requireAdmin,
    async (req: Request, res: Response) => {
      const wsId = wsIdOf(req);
      if (!wsId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      const parsed = CredentialBodySchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "invalid_payload", issues: parsed.error.flatten() });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { workspaceId: wsId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const view = await saveCredential(
          prisma,
          tenant.id,
          parsed.data.kind,
          parsed.data.creds,
          encryptionKey,
        );
        res.status(201).json({ ok: true, credential: view });
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // ── POST /api/admin/tenant/:wsId/credentials/:kind/test ─────────────────
  app.post(
    "/api/admin/tenant/:wsId/credentials/:kind/test",
    requireAdmin,
    async (req: Request, res: Response) => {
      const wsId = wsIdOf(req);
      const kindRaw = req.params.kind;
      const kind = Array.isArray(kindRaw) ? (kindRaw[0] ?? "") : (kindRaw ?? "");
      if (!wsId || !kind) {
        res.status(400).json({ error: "missing_params" });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { workspaceId: wsId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const result = await testCredential(
          prisma,
          tenant.id,
          kind,
          encryptionKey,
          deps.fetchImpl,
        );
        res.json(result);
      } catch (err) {
        sendError(res, err);
      }
    },
  );

  // ── DELETE /api/admin/tenant/:wsId/credentials/:kind ────────────────────
  app.delete(
    "/api/admin/tenant/:wsId/credentials/:kind",
    requireAdmin,
    async (req: Request, res: Response) => {
      const wsId = wsIdOf(req);
      const kindRaw = req.params.kind;
      const kind = Array.isArray(kindRaw) ? (kindRaw[0] ?? "") : (kindRaw ?? "");
      if (!wsId || !kind) {
        res.status(400).json({ error: "missing_params" });
        return;
      }
      try {
        const tenant = await prisma.tenant.findUnique({
          where: { workspaceId: wsId },
        });
        if (!tenant) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const result = await deleteCredential(prisma, tenant.id, kind);
        res.json({ ok: true, ...result });
      } catch (err) {
        sendError(res, err);
      }
    },
  );
}
