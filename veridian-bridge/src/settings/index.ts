/**
 * Page Settings tenant (U8) — barrel export.
 */

export {
  getTenantSettings,
  updateTenantSettings,
  SettingsError,
  type TenantSettingsView,
  type SettingsUpdate,
} from "./store.js";

export {
  registerSettingsRoutes,
  type SettingsRoutesDeps,
} from "./routes.js";
