/**
 * Veridian POC Bridge Stub — entrypoint
 *
 * Lit la config depuis process.env, valide, et démarre le serveur Express.
 * Toute la logique de base est dans `app.ts`. Les features optionnelles
 * (Hub HMAC §B3, GSC integration §A4) sont branchées ici via leur propre
 * registerXxxRoutes() quand les ENV correspondantes sont présentes.
 */

import { createApp, validateConfig, type BridgeConfig } from "./app.js";
import { assertSkipHmacAllowed } from "./hub-hmac.js";
import { registerGscRoutes } from "./gsc/routes.js";
import { readOauthConfigFromEnv, OauthConfigError } from "./gsc/index.js";
import { registerFormsRoutes } from "./forms/index.js";
import { registerPushRoutes } from "./push/routes.js";
import {
  configureWebPush,
  readVapidConfigFromEnv,
  PushConfigError,
} from "./push/index.js";
import { registerSettingsRoutes } from "./settings/index.js";
import {
  readEncryptionKeyFromEnv,
  CredentialCryptoError,
} from "./credentials/index.js";
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
  adminEmail: process.env.STAMINADS_ADMIN_EMAIL ?? "admin@veridian.local",
  adminPassword: process.env.STAMINADS_ADMIN_PASSWORD ?? "poc-admin-pass-2026",
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

// ─── Forms feature (B1) — optional ────────────────────────────────────
//
// On câble si BRIDGE_DATABASE_URL est présent (sinon pas de Prisma).
// `getPrisma()` est partagé avec GSC : même singleton.
try {
  if (!process.env.BRIDGE_DATABASE_URL) {
    throw new Error("BRIDGE_DATABASE_URL missing — Forms feature disabled");
  }
  const prisma = getPrisma();

  function requireAdminForForms(
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

  registerFormsRoutes(app, {
    prisma,
    requireAdmin: requireAdminForForms,
    staminadsUrl: cfg.staminadsUrl,
  });
  console.log("[bridge] Forms routes registered");
} catch (err) {
  console.warn(
    `[bridge] Forms init failed (continuing without): ${(err as Error).message}`,
  );
}

// ─── Push notifications (B2) — optional ──────────────────────────────────
try {
  if (!process.env.BRIDGE_DATABASE_URL) {
    throw new PushConfigError(
      "BRIDGE_DATABASE_URL missing — Push feature disabled",
    );
  }
  const vapid = readVapidConfigFromEnv();
  configureWebPush(vapid);
  const prisma = getPrisma();

  function requireAdminForPush(
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

  registerPushRoutes(app, { prisma, requireAdmin: requireAdminForPush });
  console.log("[bridge] Push routes registered");
} catch (err) {
  if (err instanceof PushConfigError) {
    console.warn(`[bridge] Push disabled: ${err.message}`);
  } else {
    console.warn(
      `[bridge] Push init failed (continuing without): ${(err as Error).message}`,
    );
  }
}

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
   * Hook staminads pour provision-existing : login admin (token court-vécu,
   * pas de cache — l'endpoint est appelé 5x au plus pendant une migration)
   * puis workspaces.create + apiKeys.create.
   */
  async function createStaminadsWorkspaceForMigration(input: {
    workspaceId: string;
    workspaceName: string;
    domain: string;
  }): Promise<{ workspaceId: string; apiKey: string }> {
    const loginRes = await fetch(`${cfg.staminadsUrl}/api/auth.login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: cfg.adminEmail,
        password: cfg.adminPassword,
      }),
    });
    if (!loginRes.ok) {
      throw new Error(`staminads auth.login failed: ${loginRes.status}`);
    }
    const { access_token: token } = (await loginRes.json()) as {
      access_token: string;
    };

    const wsRes = await fetch(`${cfg.staminadsUrl}/api/workspaces.create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        id: input.workspaceId,
        name: input.workspaceName,
        website: `https://${input.domain}`,
        timezone: "Europe/Paris",
        currency: "EUR",
      }),
    });
    if (!wsRes.ok) {
      throw new Error(`staminads workspaces.create failed: ${wsRes.status}`);
    }
    const ws = (await wsRes.json()) as { id: string };

    const keyRes = await fetch(`${cfg.staminadsUrl}/api/apiKeys.create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        workspace_id: ws.id,
        name: `veridian-migration-${input.workspaceId}`,
        role: "admin",
      }),
    });
    if (!keyRes.ok) {
      throw new Error(`staminads apiKeys.create failed: ${keyRes.status}`);
    }
    const apiKey = (await keyRes.json()) as { key: string };
    return { workspaceId: ws.id, apiKey: apiKey.key };
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

app.listen(PORT, () => {
  console.log(`[bridge] listening on :${PORT} → staminads ${cfg.staminadsUrl}`);
});
