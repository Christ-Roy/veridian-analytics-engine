/**
 * Couche DB des settings tenant self-service (U8).
 *
 * Agrège la config complète d'un tenant pour la page console `/settings` :
 *   - identité tenant (name, slug, plan, status)
 *   - sites & tracking (domaine, siteKey)
 *   - statut GSC (connecté / dernière sync)
 *   - credentials VoIP (masqués — délégué à `src/credentials/store.ts`)
 *   - préférences notifications / tracking (`TenantSettings`)
 *
 * `getTenantSettings`  : vue complète (GET).
 * `updateTenantSettings` : upsert des préférences notifications/tracking (PUT).
 *
 * Le compte (email/password) n'est PAS géré ici — il vit côté auth staminads
 * (la console réutilise les endpoints `account` staminads). Cette couche
 * couvre uniquement ce qui est propre au bridge Veridian.
 */

import type { PrismaClient } from "@prisma/client";
import { listCredentials, type CredentialView } from "../credentials/store.js";

export class SettingsError extends Error {
  constructor(
    message: string,
    public readonly code: "tenant_not_found" | "invalid_settings",
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

// ─── Vue settings ───────────────────────────────────────────────────────────

export interface TenantSettingsView {
  tenant: {
    id: string;
    workspaceId: string;
    slug: string;
    name: string;
    plan: string;
    status: string;
  };
  sites: Array<{
    id: string;
    domain: string;
    name: string;
    siteKey: string;
    createdAt: string;
  }>;
  gsc: {
    connected: boolean;
    propertyUrl: string | null;
    ownershipState: string | null;
    lastSyncAt: string | null;
  };
  credentials: CredentialView[];
  notifications: {
    notifyNewLead: boolean;
    notifyWeeklyReport: boolean;
    notifyEmail: string | null;
    pushAdminEnabled: boolean;
  };
  tracking: {
    visitorIdEnabled: boolean;
    cookieConsentEnabled: boolean;
  };
}

/** Valeurs par défaut des préférences quand aucune row `TenantSettings`. */
const DEFAULT_SETTINGS = {
  notifyNewLead: true,
  notifyWeeklyReport: true,
  notifyEmail: null as string | null,
  pushAdminEnabled: true,
  visitorIdEnabled: true,
  cookieConsentEnabled: false,
};

/**
 * Résout un Tenant par son `workspaceId` (l'identifiant staminads exposé
 * dans l'URL `/settings` côté console). Throw `SettingsError` si absent.
 */
async function resolveTenant(prisma: PrismaClient, workspaceId: string) {
  const tenant = await prisma.tenant.findUnique({ where: { workspaceId } });
  if (!tenant) {
    throw new SettingsError(
      `tenant_not_found:${workspaceId}`,
      "tenant_not_found",
    );
  }
  return tenant;
}

/**
 * Construit la vue settings complète d'un tenant.
 */
export async function getTenantSettings(
  prisma: PrismaClient,
  workspaceId: string,
  encryptionKey: string,
): Promise<TenantSettingsView> {
  const tenant = await resolveTenant(prisma, workspaceId);

  const [sites, gscProps, settingsRow, credentials] = await Promise.all([
    prisma.site.findMany({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    }),
    prisma.gscProperty.findMany({
      where: { tenantId: tenant.id },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.tenantSettings.findUnique({ where: { tenantId: tenant.id } }),
    listCredentials(prisma, tenant.id, encryptionKey),
  ]);

  // GSC : la property "réelle" est celle dont le siteUrl n'est pas le
  // placeholder `__pending__`. Une property `__pending__` = OAuth fait mais
  // pas encore de propriété sélectionnée → on considère "connecté" quand même
  // (le token existe) mais sans propertyUrl.
  const realProp = gscProps.find((p) => p.siteUrl !== "__pending__");
  const anyProp = realProp ?? gscProps[0];
  const gsc = {
    connected: gscProps.length > 0,
    propertyUrl: realProp ? realProp.siteUrl : null,
    ownershipState: anyProp ? anyProp.ownershipState : null,
    lastSyncAt: anyProp?.lastSyncAt ? anyProp.lastSyncAt.toISOString() : null,
  };

  const s = settingsRow ?? DEFAULT_SETTINGS;

  return {
    tenant: {
      id: tenant.id,
      workspaceId: tenant.workspaceId,
      slug: tenant.slug,
      name: tenant.name,
      plan: tenant.plan,
      status: tenant.status,
    },
    sites: sites.map((site) => ({
      id: site.id,
      domain: site.domain,
      name: site.name,
      siteKey: site.siteKey,
      createdAt: site.createdAt.toISOString(),
    })),
    gsc,
    credentials,
    notifications: {
      notifyNewLead: s.notifyNewLead,
      notifyWeeklyReport: s.notifyWeeklyReport,
      notifyEmail: s.notifyEmail ?? null,
      pushAdminEnabled: s.pushAdminEnabled,
    },
    tracking: {
      visitorIdEnabled: s.visitorIdEnabled,
      cookieConsentEnabled: s.cookieConsentEnabled,
    },
  };
}

// ─── Update ─────────────────────────────────────────────────────────────────

/** Champs modifiables via PUT /settings — tous optionnels (patch partiel). */
export interface SettingsUpdate {
  notifyNewLead?: boolean;
  notifyWeeklyReport?: boolean;
  notifyEmail?: string | null;
  pushAdminEnabled?: boolean;
  visitorIdEnabled?: boolean;
  cookieConsentEnabled?: boolean;
}

/**
 * Met à jour les préférences notifications/tracking d'un tenant.
 * Upsert : crée la row `TenantSettings` si elle n'existe pas encore.
 * Patch partiel — seuls les champs fournis sont écrits.
 */
export async function updateTenantSettings(
  prisma: PrismaClient,
  workspaceId: string,
  update: SettingsUpdate,
  encryptionKey: string,
): Promise<TenantSettingsView> {
  const tenant = await resolveTenant(prisma, workspaceId);

  // Construit le patch en ne gardant que les champs définis.
  const patch: Record<string, unknown> = {};
  for (const key of [
    "notifyNewLead",
    "notifyWeeklyReport",
    "notifyEmail",
    "pushAdminEnabled",
    "visitorIdEnabled",
    "cookieConsentEnabled",
  ] as const) {
    if (update[key] !== undefined) patch[key] = update[key];
  }

  await prisma.tenantSettings.upsert({
    where: { tenantId: tenant.id },
    update: patch,
    create: {
      tenantId: tenant.id,
      ...DEFAULT_SETTINGS,
      ...patch,
    },
  });

  return getTenantSettings(prisma, workspaceId, encryptionKey);
}
