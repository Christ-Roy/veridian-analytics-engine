/**
 * Veridian POC Bridge Stub — entrypoint
 *
 * Lit la config depuis process.env, valide, et démarre le serveur Express.
 * Toute la logique est dans `app.ts` pour rester testable.
 */

import { createApp, validateConfig, type BridgeConfig } from "./app.js";
import { assertSkipHmacAllowed } from "./hub-hmac.js";

const skipHmac = process.env.SKIP_HMAC === "true";

// Garde-fou §6.6 : SKIP_HMAC=true interdit en prod/staging.
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

// Log empreinte secret (§6.5 garde-fou) — 8 premiers chars OK à logger.
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

app.listen(PORT, () => {
  console.log(`[bridge] listening on :${PORT} → staminads ${cfg.staminadsUrl}`);
});
