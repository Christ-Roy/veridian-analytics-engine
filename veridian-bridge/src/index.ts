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
import { getPrisma } from "./db/prisma.js";
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

app.listen(PORT, () => {
  console.log(`[bridge] listening on :${PORT} → staminads ${cfg.staminadsUrl}`);
});
