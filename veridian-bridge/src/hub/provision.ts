/**
 * POST /api/tenants/provision — endpoint Hub HMAC.
 *
 * Source : CONTRAT-HUB §5.1.
 *
 * 3 cas idempotents :
 *   A — nouveau tenant → crée Tenant + workspace staminads + apiKey
 *   B — ré-attach même hubTenantId + même owner_email → refresh apiKey
 *   C — conflit : même hubTenantId, owner_email différent → 409
 *
 * Coordonne staminads :
 *   1. Crée le workspace côté staminads (id slugifié)
 *   2. Crée l'apiKey staminads (role=admin)
 *   3. Persiste Tenant côté bridge avec la apiKey staminads
 */

import type { Request, Response } from "express";
import { z } from "zod";
import type { TenantStore } from "./store.js";

const SUPPORTED_PLANS = [
  "free",
  "freemium",
  "starter",
  "pro",
  "business",
  "enterprise",
  "lifetime_site_vitrine",
  "lifetime_partner",
  "internal",
] as const;

const ProvisionSchema = z.object({
  tenant_id: z.string().min(1).max(128),
  owner_email: z.string().email(),
  workspace_name: z.string().min(1).max(120),
  plan: z.enum(SUPPORTED_PLANS),
  metadata: z.record(z.unknown()).optional(),
  locale: z.string().optional(),
});

export interface ProvisionDeps {
  store: TenantStore;
  /**
   * Hook staminads/Engine : provisionne le workspace + apiKey, retourne les
   * identifiants. Idempotent :
   *   - Cas A (nouveau tenant)   → `existingWorkspaceId` absent → crée tout
   *     (workspace + user owner + apiKey) via le natif tenants.provision.
   *   - Cas B (ré-attach)        → `existingWorkspaceId` fourni → régénère
   *     UNIQUEMENT une apiKey sur ce workspace existant (workspaces.provisionApiKey).
   *     Ne recrée NI le workspace NI le user (sinon le natif renvoie 409
   *     email_already_exists).
   */
  createStaminadsWorkspace(input: {
    hubTenantId: string;
    workspaceName: string;
    ownerEmail: string;
    existingWorkspaceId?: string;
  }): Promise<{ workspaceId: string; apiKey: string }>;
  /** URL publique dashboard (utilisée dans la réponse). */
  publicDashboardUrl?: string;
}

export function provisionHandler(deps: ProvisionDeps) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const parsed = ProvisionSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        error_code: "validation_failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const { tenant_id: hubTenantId, owner_email, workspace_name, plan, metadata } = parsed.data;

    try {
      const existing = await deps.store.findByHubTenantId(hubTenantId);

      // Cas C : conflit owner_email différent
      if (existing && existing.ownerEmail && existing.ownerEmail !== owner_email) {
        res.status(409).json({
          error: "tenant_conflict_owner",
          error_code: "conflict",
          message: `tenant ${hubTenantId} déjà attaché à un autre owner_email`,
        });
        return;
      }

      // Cas B : ré-attach même owner → refresh apiKey (workspace déjà créé)
      if (existing) {
        const { apiKey } = await deps.createStaminadsWorkspace({
          hubTenantId,
          workspaceName: workspace_name,
          ownerEmail: owner_email,
          existingWorkspaceId: existing.workspaceId,
        });
        const refreshed = await deps.store.refreshApiKey(hubTenantId, apiKey);
        res.json({
          tenant_id: hubTenantId,
          workspace_id: refreshed.workspaceId,
          owner_user_id: refreshed.ownerUserId ?? null,
          owner_email: refreshed.ownerEmail,
          api_key: refreshed.apiKey,
          api_key_email: `bot+${refreshed.slug}@veridian.site`,
          plan: refreshed.plan,
          created: false,
          dashboard_url: dashboardUrlFor(deps.publicDashboardUrl, refreshed.workspaceId),
        });
        return;
      }

      // Cas A : nouveau tenant
      const { workspaceId, apiKey } = await deps.createStaminadsWorkspace({
        hubTenantId,
        workspaceName: workspace_name,
        ownerEmail: owner_email,
      });
      const created = await deps.store.create({
        hubTenantId,
        workspaceName: workspace_name,
        ownerEmail: owner_email,
        plan,
        planSource: metadata?.plan_source as string | undefined,
        apiKey,
        staminadsWorkspaceId: workspaceId,
      });

      res.json({
        tenant_id: hubTenantId,
        workspace_id: workspaceId,
        owner_user_id: null,
        owner_email,
        api_key: apiKey,
        api_key_email: `bot+${created.slug}@veridian.site`,
        plan,
        created: true,
        dashboard_url: dashboardUrlFor(deps.publicDashboardUrl, workspaceId),
      });
    } catch (err) {
      res.status(500).json({
        error: "internal",
        message: (err as Error).message,
      });
    }
  };
}

function dashboardUrlFor(base: string | undefined, workspaceId: string): string {
  const root = base ?? "https://analytics.app.veridian.site";
  return `${root}/${workspaceId}`;
}
