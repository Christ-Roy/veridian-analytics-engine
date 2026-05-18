/**
 * Veridian POC Bridge Stub — entrypoint
 *
 * Lit la config depuis process.env, valide, et démarre le serveur Express.
 * Toute la logique est dans `app.ts` pour rester testable.
 */

import { createApp, validateConfig, type BridgeConfig } from "./app.js";

const cfg: BridgeConfig = {
  staminadsUrl: process.env.STAMINADS_URL ?? "http://staminads:3000",
  publicStaminadsUrl: process.env.PUBLIC_STAMINADS_URL,
  adminEmail: process.env.STAMINADS_ADMIN_EMAIL ?? "admin@veridian.local",
  adminPassword: process.env.STAMINADS_ADMIN_PASSWORD ?? "poc-admin-pass-2026",
  veridianAdminApiKey: process.env.VERIDIAN_ADMIN_API_KEY ?? "",
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
