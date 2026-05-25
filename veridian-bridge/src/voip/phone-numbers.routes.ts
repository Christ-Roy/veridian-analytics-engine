/**
 * Routes Express CRUD pour `TenantPhoneNumber` (phone source dimension,
 * 2026-05-25).
 *
 * Endpoints ADMIN (Bearer `VERIDIAN_ADMIN_API_KEY`) :
 *   GET    /api/admin/tenant/:wsId/phone-numbers
 *   POST   /api/admin/tenant/:wsId/phone-numbers           {e164, source, label?}
 *   PUT    /api/admin/tenant/:wsId/phone-numbers/:id       {source?, label?}
 *   DELETE /api/admin/tenant/:wsId/phone-numbers/:id
 *
 * `:wsId` accepte l'id interne OU le `workspaceId` (cohérent avec les autres
 * routes admin VoIP / Settings — la page Settings ne connaît que le workspaceId).
 *
 * Validation E.164 stricte : on stocke uniquement des numéros qui passent
 * `toE164()` (cf phone-numbers.ts). Un POST avec un format ambigu retourne 400.
 *
 * Module isolé style B-VOIP — wirable via `registerPhoneNumbersRoutes(app, deps)`.
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { PrismaClient, PhoneNumberSource } from "@prisma/client";
import {
  PHONE_NUMBER_SOURCES,
  isPhoneSource,
  toE164,
} from "./phone-numbers.js";

export interface PhoneNumbersRoutesDeps {
  prisma: PrismaClient;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
}

interface ViewRow {
  id: string;
  e164: string;
  source: PhoneNumberSource;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(r: {
  id: string;
  e164: string;
  source: PhoneNumberSource;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ViewRow {
  return {
    id: r.id,
    e164: r.e164,
    source: r.source,
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Résout `:wsId` en `tenant.id` interne. Renvoie null si introuvable. */
async function resolveTenantId(
  prisma: PrismaClient,
  wsIdRaw: string,
): Promise<string | null> {
  let tenant = await prisma.tenant.findUnique({
    where: { id: wsIdRaw },
    select: { id: true },
  });
  if (!tenant) {
    tenant = await prisma.tenant.findUnique({
      where: { workspaceId: wsIdRaw },
      select: { id: true },
    });
  }
  return tenant?.id ?? null;
}

export function registerPhoneNumbersRoutes(
  app: Express,
  deps: PhoneNumbersRoutesDeps,
): void {
  // ── GET /api/admin/tenant/:wsId/phone-numbers ─────────────────────────────
  app.get(
    "/api/admin/tenant/:wsId/phone-numbers",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const wsId =
        typeof req.params.wsId === "string" ? req.params.wsId : "";
      if (!wsId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      try {
        const tenantId = await resolveTenantId(deps.prisma, wsId);
        if (!tenantId) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const rows = await deps.prisma.tenantPhoneNumber.findMany({
          where: { tenantId },
          orderBy: { createdAt: "asc" },
        });
        res.json({
          phoneNumbers: rows.map(toView),
          allowedSources: PHONE_NUMBER_SOURCES,
        });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  // ── POST /api/admin/tenant/:wsId/phone-numbers ────────────────────────────
  // Body: { e164: string, source: PhoneSource, label?: string }
  app.post(
    "/api/admin/tenant/:wsId/phone-numbers",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const wsId =
        typeof req.params.wsId === "string" ? req.params.wsId : "";
      if (!wsId) {
        res.status(400).json({ error: "missing_workspace_id" });
        return;
      }
      const body = req.body as {
        e164?: unknown;
        source?: unknown;
        label?: unknown;
      };
      const e164Raw = typeof body.e164 === "string" ? body.e164 : "";
      const sourceRaw = typeof body.source === "string" ? body.source : "";
      const labelRaw =
        typeof body.label === "string" && body.label.trim().length > 0
          ? body.label.trim().slice(0, 120)
          : null;

      const normalized = toE164(e164Raw);
      if (!normalized) {
        res
          .status(400)
          .json({ error: "invalid_e164", hint: "format attendu: +33...." });
        return;
      }
      if (!isPhoneSource(sourceRaw)) {
        res.status(400).json({
          error: "invalid_source",
          allowed: PHONE_NUMBER_SOURCES,
        });
        return;
      }

      try {
        const tenantId = await resolveTenantId(deps.prisma, wsId);
        if (!tenantId) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        // Check unicité (tenantId, e164) avant create pour un 409 propre.
        const existing = await deps.prisma.tenantPhoneNumber.findUnique({
          where: { tenantId_e164: { tenantId, e164: normalized } },
        });
        if (existing) {
          res.status(409).json({
            error: "already_exists",
            e164: normalized,
            id: existing.id,
          });
          return;
        }
        const row = await deps.prisma.tenantPhoneNumber.create({
          data: {
            tenantId,
            e164: normalized,
            source: sourceRaw as PhoneNumberSource,
            label: labelRaw,
          },
        });
        res.status(201).json({ ok: true, phoneNumber: toView(row) });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  // ── PUT /api/admin/tenant/:wsId/phone-numbers/:id ─────────────────────────
  // Body: { source?: PhoneSource, label?: string|null }
  // Note : on ne permet PAS de changer l'e164 (= clé business). Pour ça,
  // delete + create.
  app.put(
    "/api/admin/tenant/:wsId/phone-numbers/:id",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const wsId =
        typeof req.params.wsId === "string" ? req.params.wsId : "";
      const id = typeof req.params.id === "string" ? req.params.id : "";
      if (!wsId || !id) {
        res.status(400).json({ error: "missing_param" });
        return;
      }
      const body = req.body as { source?: unknown; label?: unknown };
      const patch: { source?: PhoneNumberSource; label?: string | null } = {};
      if (body.source !== undefined) {
        if (!isPhoneSource(body.source)) {
          res.status(400).json({
            error: "invalid_source",
            allowed: PHONE_NUMBER_SOURCES,
          });
          return;
        }
        patch.source = body.source as PhoneNumberSource;
      }
      if (body.label !== undefined) {
        if (body.label === null) {
          patch.label = null;
        } else if (typeof body.label === "string") {
          const trimmed = body.label.trim();
          patch.label = trimmed.length === 0 ? null : trimmed.slice(0, 120);
        } else {
          res.status(400).json({ error: "invalid_label" });
          return;
        }
      }
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "empty_patch" });
        return;
      }

      try {
        const tenantId = await resolveTenantId(deps.prisma, wsId);
        if (!tenantId) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        // Vérifie que la row appartient bien au tenant (sécu cross-tenant).
        const row = await deps.prisma.tenantPhoneNumber.findUnique({
          where: { id },
        });
        if (!row || row.tenantId !== tenantId) {
          res.status(404).json({ error: "phone_number_not_found" });
          return;
        }
        const updated = await deps.prisma.tenantPhoneNumber.update({
          where: { id },
          data: patch,
        });
        res.json({ ok: true, phoneNumber: toView(updated) });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );

  // ── DELETE /api/admin/tenant/:wsId/phone-numbers/:id ──────────────────────
  app.delete(
    "/api/admin/tenant/:wsId/phone-numbers/:id",
    deps.requireAdmin,
    async (req: Request, res: Response) => {
      const wsId =
        typeof req.params.wsId === "string" ? req.params.wsId : "";
      const id = typeof req.params.id === "string" ? req.params.id : "";
      if (!wsId || !id) {
        res.status(400).json({ error: "missing_param" });
        return;
      }
      try {
        const tenantId = await resolveTenantId(deps.prisma, wsId);
        if (!tenantId) {
          res.status(404).json({ error: "tenant_not_found" });
          return;
        }
        const row = await deps.prisma.tenantPhoneNumber.findUnique({
          where: { id },
        });
        if (!row || row.tenantId !== tenantId) {
          res.status(404).json({ error: "phone_number_not_found" });
          return;
        }
        await deps.prisma.tenantPhoneNumber.delete({ where: { id } });
        res.json({ ok: true, deleted: true });
      } catch (err) {
        res
          .status(500)
          .json({ error: "internal", message: (err as Error).message });
      }
    },
  );
}
