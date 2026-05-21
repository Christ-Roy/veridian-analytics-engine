/**
 * POST /api/tenants/attach-owner — endpoint Hub HMAC.
 *
 * Source : CONTRAT-HUB §5.3.
 *
 * Lie un user au tenant en mode OWNER. Idempotent : un re-attach du même
 * (tenant, email) avec le même user_id → NOOP (renvoie `already_attached: true`).
 *
 * Stratégie côté bridge :
 *   - On stocke ownerEmail + ownerUserId sur le Tenant. Staminads ne porte
 *     pas la notion de "user owner" séparée du workspace : c'est l'apiKey
 *     qui est attachée. La traçabilité humaine vit côté bridge.
 *   - Si le tenant n'existe pas → 404 tenant_not_found.
 */

import type { Request, Response } from "express";
import { z } from "zod";
import type { TenantStore } from "./store.js";

const AttachOwnerSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  owner_email: z.string().email(),
  user_id: z.string().min(1).max(128).optional(),
  role: z.enum(["owner", "admin"]).optional().default("owner"),
});

export interface AttachOwnerDeps {
  store: TenantStore;
}

export function attachOwnerHandler(deps: AttachOwnerDeps) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const parsed = AttachOwnerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        error_code: "validation_failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { tenant_id: hubTenantId, owner_email, user_id, role } = parsed.data;
    const resolvedUserId = user_id ?? `usr_${owner_email.replace(/[^a-z0-9]/gi, "_")}`;

    try {
      const existing = await deps.store.findByHubTenantId(hubTenantId);
      if (!existing) {
        res.status(404).json({
          error: "tenant_not_found",
          error_code: "tenant_not_found",
          message: `tenant ${hubTenantId} introuvable`,
        });
        return;
      }

      const { tenant, alreadyAttached } = await deps.store.attachOwner(
        hubTenantId,
        owner_email,
        resolvedUserId
      );

      res.json({
        tenant_id: hubTenantId,
        owner_email,
        user_id: tenant.ownerUserId,
        attached: true,
        already_attached: alreadyAttached,
        role,
      });
    } catch (err) {
      res.status(500).json({
        error: "internal",
        message: (err as Error).message,
      });
    }
  };
}
