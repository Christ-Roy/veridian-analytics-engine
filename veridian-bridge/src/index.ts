/**
 * Veridian POC Bridge Stub — entrypoint
 *
 * Lit la config depuis process.env, valide, et démarre le serveur Express.
 * Toute la logique de base est dans `app.ts`. Les features optionnelles
 * (Hub HMAC §B3, GSC integration §A4) sont branchées ici via leur propre
 * registerXxxRoutes() quand les ENV correspondantes sont présentes.
 */

import { createApp, validateConfig, type BridgeConfig } from "./app.js";
import { createEngineM2mClient } from "./engine-m2m.js";
import { assertSkipHmacAllowed } from "./hub-hmac.js";
import { registerGscRoutes } from "./gsc/routes.js";
import { readOauthConfigFromEnv, OauthConfigError } from "./gsc/index.js";
import { registerSettingsRoutes } from "./settings/index.js";
import {
  readEncryptionKeyFromEnv,
  CredentialCryptoError,
} from "./credentials/index.js";
import {
  registerVoipRoutes,
  registerPhoneNumbersRoutes,
} from "./voip/index.js";
import { getPrisma } from "./db/prisma.js";
import { registerProvisionExistingRoutes } from "./admin/provision-existing-tenant.js";
import type { Request, Response, NextFunction } from "express";

// ─── Hub HMAC (B3) ──────────────────────────────────────────────────
const skipHmac = process.env.SKIP_HMAC === "true";

try {
  assertSkipHmacAllowed(skipHmac, process.env.NODE_ENV);
} catch (err) {
  console.error(`[bridge] boot guard: ${(err as Error).message}`);
  process.exit(1);
}

const hubHmacSecret = process.env.HUB_HMAC_SECRET ?? "";
if (!skipHmac && hubHmacSecret.length < 32) {
  console.warn(
    "[bridge] WARN: HUB_HMAC_SECRET absent ou < 32 chars — routes /api/tenants/* refuseront tout (sauf si SKIP_HMAC=true)"
  );
}

console.log(
  `[bridge] HUB_HMAC_SECRET fingerprint=${hubHmacSecret.slice(0, 8)}... env=${process.env.NODE_ENV ?? "production"} skip=${skipHmac}`
);

const cfg: BridgeConfig = {
  staminadsUrl: process.env.STAMINADS_URL ?? "http://staminads:3000",
  publicStaminadsUrl: process.env.PUBLIC_STAMINADS_URL,
  platformAdminApiKey: process.env.PLATFORM_ADMIN_API_KEY ?? "",
  veridianAdminApiKey: process.env.VERIDIAN_ADMIN_API_KEY ?? "",
  hub: {
    hmacSecret: hubHmacSecret,
    skipHmac,
    publicDashboardUrl:
      process.env.PUBLIC_DASHBOARD_URL ?? "https://analytics.app.veridian.site",
  },
};

try {
  validateConfig(cfg);
} catch (err) {
  console.error(`[bridge] config error: ${(err as Error).message}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT ?? 3002);
const app = createApp(cfg);

// ─── GSC feature (A4) — optional ─────────────────────────────────────
try {
  const oauthConfig = readOauthConfigFromEnv();
  if (!process.env.BRIDGE_DATABASE_URL) {
    throw new OauthConfigError(
      "BRIDGE_DATABASE_URL missing — GSC feature disabled",
    );
  }
  const prisma = getPrisma();

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    if (token !== cfg.veridianAdminApiKey) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  }

  const cronAllowedIps = (process.env.GSC_CRON_ALLOWED_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  registerGscRoutes(app, {
    prisma,
    oauthConfig,
    requireAdmin,
    adminApiKey: cfg.veridianAdminApiKey,
    dashboardRedirectUrl: process.env.GSC_DASHBOARD_REDIRECT_URL,
    cronAllowedIps: cronAllowedIps.length > 0 ? cronAllowedIps : undefined,
  });
  console.log("[bridge] GSC routes registered");
} catch (err) {
  if (err instanceof OauthConfigError) {
    console.warn(`[bridge] GSC disabled: ${err.message}`);
  } else {
    console.warn(
      `[bridge] GSC init failed (continuing without): ${(err as Error).message}`,
    );
  }
}

// ─── Forms feature (B1) — REMOVED 2026-05-23 ──────────────────────────────
// Scope change : Robert a retiré le tracking de formulaires du périmètre
// commercialisé. Les goals staminads natifs couvrent ce besoin. Code retiré
// (cf chore/cleanup-veridian-scope). Migration 20260523000000_drop_forms_leads
// DROP les tables FormSubmission / FormSchema / Lead / LeadSession (Site est
// CONSERVÉE — utilisée par settings + provision-existing-tenant).

// ─── Push notifications (B2) — ARCHIVED 2026-05-23 ────────────────────────
// Scope change : Web Push retiré du périmètre commercialisé. Code conservé
// dans veridian-bridge/_archive/push/ pour réactivation future éventuelle.
// Les tables PushSubscription/PushNotification restent en base (pas de drop),
// cf. docs/ARCHIVED-FEATURES.md.

// ─── Settings + credentials self-service (U8) — optional ────────────────────
//
// Page /settings de la console : config tenant + credentials VoIP chiffrés.
// Nécessite Postgres (BRIDGE_DATABASE_URL) + clé de chiffrement
// (TOKEN_ENCRYPTION_KEY, partagée avec GSC).
try {
  if (!process.env.BRIDGE_DATABASE_URL) {
    throw new CredentialCryptoError(
      "BRIDGE_DATABASE_URL missing — Settings feature disabled",
    );
  }
  const encryptionKey = readEncryptionKeyFromEnv();
  const prisma = getPrisma();

  function requireAdminForSettings(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    if (token !== cfg.veridianAdminApiKey) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  }

  registerSettingsRoutes(app, {
    prisma,
    requireAdmin: requireAdminForSettings,
    encryptionKey,
  });
  console.log("[bridge] Settings routes registered");
} catch (err) {
  if (err instanceof CredentialCryptoError) {
    console.warn(`[bridge] Settings disabled: ${err.message}`);
  } else {
    console.warn(
      `[bridge] Settings init failed (continuing without): ${(err as Error).message}`,
    );
  }
}

// ─── Provision-existing-tenant (D2 — migration des clients legacy) ────────
//
// Endpoint POST /api/admin/provision-existing-tenant utilisé par le script
// scripts/migration/migrate-existing-tenants.ts. Adopte un site legacy
// (siteKey réutilisé) en créant le workspace staminads + Tenant/Site bridge.
try {
  if (!process.env.BRIDGE_DATABASE_URL) {
    throw new Error(
      "BRIDGE_DATABASE_URL missing — provision-existing-tenant disabled",
    );
  }
  const prisma = getPrisma();

  function requireAdminForProvisionExisting(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    if (token !== cfg.veridianAdminApiKey) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  }

  /**
   * Hook Engine M2M pour provision-existing (migration D2 des clients legacy).
   * Adopte un id de workspace EXPLICITE (legacy) via le natif
   * tenants.provision avec `workspace_id` imposé. Plus de login super_admin :
   * un seul secret M2M (PLATFORM_ADMIN_API_KEY).
   *
   * On dérive un email owner de service (le natif exige un email + crée le
   * user owner ; pour une migration le user est piloté par le Hub ensuite).
   */
  const migrationEngineM2m = createEngineM2mClient({
    engineUrl: cfg.staminadsUrl,
    platformAdminApiKey: cfg.platformAdminApiKey,
  });

  async function createStaminadsWorkspaceForMigration(input: {
    workspaceId: string;
    workspaceName: string;
    domain: string;
  }): Promise<{ workspaceId: string; apiKey: string }> {
    const result = await migrationEngineM2m.provisionTenant({
      email: `bot+${input.workspaceId}@veridian.site`,
      name: input.workspaceName,
      siteUrl: `https://${input.domain}`,
      workspace_id: input.workspaceId,
      timezone: "Europe/Paris",
    });
    return { workspaceId: result.workspace_id, apiKey: result.api_key };
  }

  registerProvisionExistingRoutes(app, {
    prisma,
    requireAdmin: requireAdminForProvisionExisting,
    createStaminadsWorkspace: createStaminadsWorkspaceForMigration,
    publicStaminadsUrl:
      process.env.PUBLIC_STAMINADS_URL ?? cfg.staminadsUrl,
    publicDashboardUrl:
      process.env.PUBLIC_DASHBOARD_URL ?? "https://analytics.app.veridian.site",
  });
  console.log("[bridge] provision-existing-tenant route registered");
} catch (err) {
  console.warn(
    `[bridge] provision-existing-tenant disabled: ${(err as Error).message}`,
  );
}

// ─── VoIP call logs (B-VOIP) — optional ─────────────────────────────────────
//
// Pull les CDR (OVH Telephony / Telnyx) → table SipCall + tab Calls. Lit les
// credentials VoIP saisis par le tenant via la page Settings (TenantCredential,
// U8). Câblé si BRIDGE_DATABASE_URL + TOKEN_ENCRYPTION_KEY sont présents.
try {
  if (!process.env.BRIDGE_DATABASE_URL) {
    throw new CredentialCryptoError(
      "BRIDGE_DATABASE_URL missing — VoIP feature disabled",
    );
  }
  const encryptionKey = readEncryptionKeyFromEnv();
  const prisma = getPrisma();

  function requireAdminForVoip(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const auth = req.header("authorization");
    if (!auth?.startsWith("Bearer ")) {
      res.status(401).json({ error: "missing_bearer" });
      return;
    }
    const token = auth.slice("Bearer ".length).trim();
    if (token !== cfg.veridianAdminApiKey) {
      res.status(403).json({ error: "invalid_admin_key" });
      return;
    }
    next();
  }

  const voipCronAllowedIps = (process.env.VOIP_CRON_ALLOWED_IPS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  registerVoipRoutes(app, {
    prisma,
    requireAdmin: requireAdminForVoip,
    adminApiKey: cfg.veridianAdminApiKey,
    encryptionKey,
    cronAllowedIps:
      voipCronAllowedIps.length > 0 ? voipCronAllowedIps : undefined,
  });
  registerPhoneNumbersRoutes(app, {
    prisma,
    requireAdmin: requireAdminForVoip,
  });
  console.log("[bridge] VoIP routes registered (incl. phone-numbers CRUD)");
} catch (err) {
  if (err instanceof CredentialCryptoError) {
    console.warn(`[bridge] VoIP disabled: ${err.message}`);
  } else {
    console.warn(
      `[bridge] VoIP init failed (continuing without): ${(err as Error).message}`,
    );
  }
}

app.listen(PORT, () => {
  console.log(`[bridge] listening on :${PORT} → staminads ${cfg.staminadsUrl}`);
});
