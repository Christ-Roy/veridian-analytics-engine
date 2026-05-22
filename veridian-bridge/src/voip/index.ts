/**
 * VoIP integration (B-VOIP) — barrel export.
 *
 * Le bridge pull les call logs (CDR) des tenants ayant branché un provider
 * VoIP (OVH Telephony / Telnyx) via la page Settings (creds stockés par U8
 * dans `TenantCredential`), les upsert dans `SipCall`, matche les `visitorId`
 * et alimente le tab Calls du dashboard.
 *
 * B-VOIP NE gère PAS le CRUD des credentials (saisie / test / suppression) :
 * c'est U8 (`src/credentials/` + page Settings). B-VOIP est consommateur en
 * lecture des `TenantCredential` de kind VoIP.
 */

export {
  loadVoipCredentials,
  markVoipSyncResult,
  providerToKind,
  isVoipKind,
  type VoipProvider,
  type LoadedVoipCredential,
} from "./credentials.js";

export {
  VoipApiError,
  type CallDirection,
  type CallStatus,
  type NormalizedCall,
  type FetchCdrOptions,
} from "./types.js";

export { fetchOvhCdr, normalizeOvhConsumption } from "./providers/ovh.js";

export { fetchTelnyxCdr, normalizeTelnyxCdr } from "./providers/telnyx.js";

export { resolveVisitorIds, normalizePhone } from "./match.js";

export {
  syncCallLogs,
  syncAllCallLogs,
  type ProviderSyncResult,
  type SyncCallLogsResult,
  type SyncCallLogsOptions,
} from "./sync.js";

export { listCalls, type CallRow, type CallsSummary } from "./query.js";

export { registerVoipRoutes, type VoipRoutesDeps } from "./routes.js";
