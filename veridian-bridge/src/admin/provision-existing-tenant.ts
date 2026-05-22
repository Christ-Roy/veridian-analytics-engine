/**
 * POST /api/admin/provision-existing-tenant — endpoint de migration (D2).
 *
 * Provisionne un workspace staminads + un Tenant/Site dans la BDD bridge à
 * partir d'un site client DÉJÀ existant côté legacy `veridian-analytics`.
 *
 * Différence avec `/api/admin/provision-tenant` :
 *   - provision-tenant     : crée un tenant tout neuf (onboarding).
 *   - provision-existing   : adopte un site legacy connu — on reçoit le
 *     `siteKey` legacy et on le RÉUTILISE comme `Site.siteKey` bridge, pour
 *     que le snippet posé côté client reste stable et que le mapping
 *     legacy ↔ bridge soit déterministe.
 *
 * Idempotence (pré-requis ticket D2) :
 *   - lookup `Site` par `siteKey` legacy.
 *   - si le Site existe déjà → on renvoie le mapping existant (created:false)
 *     SANS recréer de workspace staminads ni de row.
 *   - rejouer le script de migration N fois ne crée jamais de doublon.
 *
 * Le `visitorIdEnabled` est purement informatif : le snippet renvoyé
 * embarque `data-visitor-id="true"` quand il vaut true. Le patch staminads
 * Phase 2 (visitor_id) est un pré-requis runtime côté engine — ce flag ne
 * fait que le refléter dans le snippet généré.
 *
 * Auth : Bearer `VERIDIAN_ADMIN_API_KEY` (même garde que provision-tenant).
 */

import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

/** Slugifie un identifiant Veridian en id staminads valide ([a-z][a-z0-9_]*, 2-50). */
export function toStaminadsWorkspaceId(slug: string): string {
  const cleaned = slug
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[^a-z]/, "v_$&")
    .slice(0, 50);
  // staminads exige >= 2 chars. Un slug d'un seul char (rare) → padding.
  return cleaned.length >= 2 ? cleaned : `v_${cleaned}`;
}

/**
 * Construit le snippet `<script>` à coller dans le `<head>` du site client.
 * Le tracker staminads est servi depuis `publicStaminadsUrl`. En migration
 * D2 ce snippet est posé EN PLUS du tracker legacy (dual-tracking).
 */
export function buildTrackerSnippet(input: {
  workspaceId: string;
  endpoint: string;
  visitorIdEnabled: boolean;
}): string {
  // On retire un éventuel slash final pour une concaténation propre.
  const endpoint = input.endpoint.replace(/\/+$/, "");
  const visitorAttr = input.visitorIdEnabled
    ? ' data-visitor-id="true"'
    : "";
  return [
    `<!-- Veridian Analytics (staminads) — dual-tracking migration D2 -->`,
    `<script`,
    `  defer`,
    `  src="${endpoint}/js/script.js"`,
    `  data-workspace-id="${input.workspaceId}"`,
    `  data-api-endpoint="${endpoint}/api/track"${visitorAttr}`,
    `></script>`,
  ].join("\n");
}

const ProvisionExistingSchema = z.object({
  /** siteKey legacy (réutilisé tel quel comme Site.siteKey bridge). */
  siteKey: z.string().min(1).max(128),
  /** slug du tenant côté Veridian (autorise les tirets). */
  slug: z.string().min(1).max(64),
  /** domaine du site client (ex: "morel-volailles.com"). */
  domain: z.string().min(1).max(253),
  /** nom lisible — défaut : le slug. */
  name: z.string().min(1).max(120).optional(),
  /** active visitor_id dans le snippet (défaut true pour la migration). */
  visitorIdEnabled: z.boolean().default(true),
});

export type ProvisionExistingInput = z.infer<typeof ProvisionExistingSchema>;

export interface ProvisionExistingDeps {
  prisma: PrismaClient;
  /**
   * Hook staminads : crée le workspace + apiKey, renvoie les identifiants.
   * Injecté pour rester testable sans monter un faux serveur staminads.
   */
  createStaminadsWorkspace(input: {
    workspaceId: string;
    workspaceName: string;
    domain: string;
  }): Promise<{ workspaceId: string; apiKey: string }>;
  /** URL publique du tracker staminads (snippet). */
  publicStaminadsUrl: string;
  /** Racine du dashboard Veridian Analytics. */
  publicDashboardUrl: string;
}

export interface ProvisionExistingResult {
  tenantId: string;
  workspaceId: string;
  siteId: string;
  siteKey: string;
  apiKey: string | null;
  snippet: string;
  dashboardUrl: string;
  created: boolean;
}

/**
 * Logique métier de provisionning, hors couche HTTP — testable directement.
 * Idempotent : un `Site` déjà existant pour ce `siteKey` court-circuite la
 * création (aucun appel staminads, aucune écriture).
 */
export async function provisionExistingTenant(
  deps: ProvisionExistingDeps,
  input: ProvisionExistingInput,
): Promise<ProvisionExistingResult> {
  // 1. Idempotence — le Site legacy a-t-il déjà été adopté ?
  const existingSite = await deps.prisma.site.findUnique({
    where: { siteKey: input.siteKey },
    include: { tenant: true },
  });

  if (existingSite) {
    return {
      tenantId: existingSite.tenant.id,
      workspaceId: existingSite.tenant.workspaceId,
      siteId: existingSite.id,
      siteKey: existingSite.siteKey,
      apiKey: existingSite.tenant.apiKey,
      snippet: buildTrackerSnippet({
        workspaceId: existingSite.tenant.workspaceId,
        endpoint: deps.publicStaminadsUrl,
        visitorIdEnabled: input.visitorIdEnabled,
      }),
      dashboardUrl: dashboardUrlFor(
        deps.publicDashboardUrl,
        existingSite.tenant.workspaceId,
      ),
      created: false,
    };
  }

  // 2. Le slug est peut-être déjà pris par un Tenant (ex: provision-tenant
  //    a déjà créé le tenant, mais pas le Site). On le réutilise alors.
  const workspaceId = toStaminadsWorkspaceId(input.slug);
  const name = input.name ?? input.slug;

  let tenant = await deps.prisma.tenant.findUnique({
    where: { slug: input.slug },
  });

  if (!tenant) {
    // 3. Nouveau tenant → crée le workspace staminads + apiKey.
    const ws = await deps.createStaminadsWorkspace({
      workspaceId,
      workspaceName: name,
      domain: input.domain,
    });
    tenant = await deps.prisma.tenant.create({
      data: {
        workspaceId: ws.workspaceId,
        slug: input.slug,
        name,
        plan: "free",
        planSource: "manual",
        status: "active",
        apiKey: ws.apiKey,
      },
    });
  }

  // 4. Crée le Site bridge en réutilisant le siteKey legacy.
  const site = await deps.prisma.site.create({
    data: {
      tenantId: tenant.id,
      siteKey: input.siteKey,
      domain: input.domain,
      name,
    },
  });

  return {
    tenantId: tenant.id,
    workspaceId: tenant.workspaceId,
    siteId: site.id,
    siteKey: site.siteKey,
    apiKey: tenant.apiKey,
    snippet: buildTrackerSnippet({
      workspaceId: tenant.workspaceId,
      endpoint: deps.publicStaminadsUrl,
      visitorIdEnabled: input.visitorIdEnabled,
    }),
    dashboardUrl: dashboardUrlFor(deps.publicDashboardUrl, tenant.workspaceId),
    created: true,
  };
}

/** Express handler — parse + délègue à `provisionExistingTenant`. */
export function provisionExistingTenantHandler(deps: ProvisionExistingDeps) {
  return async function handler(req: Request, res: Response): Promise<void> {
    const parsed = ProvisionExistingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        details: parsed.error.flatten(),
      });
      return;
    }
    try {
      const result = await provisionExistingTenant(deps, parsed.data);
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      res.status(500).json({ error: "internal", message: (err as Error).message });
    }
  };
}

function dashboardUrlFor(base: string, workspaceId: string): string {
  return `${base.replace(/\/+$/, "")}/${workspaceId}`;
}

/**
 * Monte `POST /api/admin/provision-existing-tenant` sur l'app Express.
 *
 * Suit le même pattern de wiring que `registerGscRoutes` / `registerFormsRoutes`
 * (cf. `src/index.ts`) : la feature a besoin de Prisma, donc elle est branchée
 * en dehors de `createApp()` quand `BRIDGE_DATABASE_URL` est présent.
 */
export function registerProvisionExistingRoutes(
  app: Express,
  opts: { requireAdmin: RequestHandler } & ProvisionExistingDeps,
): void {
  const { requireAdmin, ...deps } = opts;
  app.post(
    "/api/admin/provision-existing-tenant",
    requireAdmin,
    provisionExistingTenantHandler(deps),
  );
}
