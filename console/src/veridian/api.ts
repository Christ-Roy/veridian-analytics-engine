/**
 * Client fetch des endpoints bridge Veridian.
 *
 * Endpoints consommés (port des handlers `veridian-bridge/src/app.ts`) :
 *   - GET  /api/admin/tenant/:workspaceId/score    (A1, auth Bearer admin)
 *   - GET  /api/admin/tenant/:workspaceId/status   (A2, auth Bearer admin)
 *   - GET  /api/admin/shadow-marketing             (A3, PUBLIC)
 *
 * Stratégie d'URL : par défaut on consomme la même origine que la console
 * (préfixe `/api/admin/...` via reverse proxy Traefik côté staging/prod —
 * c'est aussi comme ça que la console staminads upstream fait ses appels).
 *
 * L'admin token côté V1 = même session que la console staminads (cookie
 * `app_session`). Pour le bridge admin Bearer, on lit `VITE_VERIDIAN_ADMIN_KEY`
 * en build-time si exposé (env staging) OU on tombe sur un placeholder qui
 * laisse le bridge répondre 403 → l'UI affiche un error state propre.
 *
 * Pour le futur : ces endpoints seront authentifiés via session console
 * (B3 hub HMAC fait le pont), mais pour V1 dashboard on garde le Bearer.
 *
 * Note réseau : 3 fetches en parallèle (Promise.all) — chacun timeout 8s.
 */

import type { ServiceKey, ShadowMarketingEntry } from './types';

// ─── Types de réponse (miroir des handlers bridge) ────────────────────────

export interface ScoreResponse {
  workspaceId: string;
  score: number;
  label: string;
  services: {
    active: ServiceKey[];
    inactive: ServiceKey[];
  };
}

export interface TenantStatusResponse {
  workspaceId: string;
  activeServices: ServiceKey[];
  inactiveServices: ServiceKey[];
  counts: {
    pageviews: number;
    forms: number;
    calls: number;
    gscRows: number;
    gscClicks: number;
    gscImpressions: number;
    gscProperty: { propertyUrl: string; lastSyncAt: string | null } | null;
  };
}

/**
 * Shadow marketing : bridge renvoie un Record<ServiceKey, ShadowMarketingEntry>
 * MAIS sans `emailBodyTemplate` (côté serveur c'est une fonction, sérialisée
 * en placeholder `{{domain}}`). Le client doit reconstruire le mailto avec
 * la lib `buildMailto` côté front qui utilise les templates statiques.
 *
 * En pratique : on utilise les valeurs statiques de `types.ts` (SHADOW_MARKETING)
 * et l'endpoint sert juste de validation que les services sont les mêmes.
 * Ça permet à Robert de pivoter les textes côté bridge sans rebuild front.
 */
export type ShadowMarketingResponse = Record<
  ServiceKey,
  Omit<ShadowMarketingEntry, 'emailBodyTemplate'> & {
    emailBodyTemplate?: string;
  }
>;

/**
 * Réponse de `GET /api/admin/tenant/:wsId/check-tracker` — endpoint poll
 * par l'onboarding wizard `/welcome` (U4). Miroir du handler bridge
 * `veridian-bridge/src/check-tracker.ts`.
 */
export interface CheckTrackerResponse {
  status: 'ok' | 'waiting';
  firstSeenAt: string | null;
  totalEvents24h: number;
}

// ─── Erreur typée ────────────────────────────────────────────────────────

export class BridgeApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(message: string, status: number, endpoint: string) {
    super(message);
    this.name = 'BridgeApiError';
    this.status = status;
    this.endpoint = endpoint;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * URL de base du bridge. Dans la console embarquée, on assume que les
 * endpoints `/api/admin/*` sont reverse-proxied vers le bridge depuis le
 * même domaine (config Traefik staging/prod). En dev local console (port
 * 5173), tu peux override via `VITE_VERIDIAN_BRIDGE_URL`.
 */
function bridgeBase(): string {
  const env = (import.meta as ImportMeta).env as Record<string, string | undefined>;
  return env?.VITE_VERIDIAN_BRIDGE_URL ?? '';
}

function adminKey(): string {
  const env = (import.meta as ImportMeta).env as Record<string, string | undefined>;
  return env?.VITE_VERIDIAN_ADMIN_KEY ?? '';
}

type HttpMethod = 'GET' | 'PUT' | 'POST' | 'DELETE';

async function requestJson<T>(
  endpoint: string,
  opts: {
    method?: HttpMethod;
    requireAdmin?: boolean;
    signal?: AbortSignal;
    body?: unknown;
  } = {},
): Promise<T> {
  const url = `${bridgeBase()}${endpoint}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (opts.requireAdmin) {
    const key = adminKey();
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    signal: opts.signal,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = await res.text().catch(() => '');
    }
    throw new BridgeApiError(
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`,
      res.status,
      endpoint,
    );
  }

  // 204 No Content ou body vide → renvoie un objet vide typé.
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/** Conservé pour compat — wrapper GET sur `requestJson`. */
async function fetchJson<T>(
  endpoint: string,
  opts: { requireAdmin?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  return requestJson<T>(endpoint, { method: 'GET', ...opts });
}

// ─── Endpoints ───────────────────────────────────────────────────────────

export function fetchScore(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ScoreResponse> {
  return fetchJson<ScoreResponse>(
    `/api/admin/tenant/${encodeURIComponent(workspaceId)}/score`,
    { requireAdmin: true, signal: opts.signal },
  );
}

export function fetchTenantStatus(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TenantStatusResponse> {
  return fetchJson<TenantStatusResponse>(
    `/api/admin/tenant/${encodeURIComponent(workspaceId)}/status`,
    { requireAdmin: true, signal: opts.signal },
  );
}

export function fetchShadowMarketing(
  opts: { signal?: AbortSignal } = {},
): Promise<ShadowMarketingResponse> {
  return fetchJson<ShadowMarketingResponse>('/api/admin/shadow-marketing', {
    requireAdmin: false,
    signal: opts.signal,
  });
}

/**
 * Vérifie si le tracker est actif pour un workspace — poll par l'onboarding
 * wizard `/welcome` toutes les 5s. `status: 'ok'` dès le premier pageview
 * reçu. Un workspace vide n'est PAS une erreur : le bridge répond 200
 * `{ status: 'waiting' }`.
 */
export function fetchCheckTracker(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<CheckTrackerResponse> {
  return fetchJson<CheckTrackerResponse>(
    `/api/admin/tenant/${encodeURIComponent(workspaceId)}/check-tracker`,
    { requireAdmin: true, signal: opts.signal },
  );
}

// ─── Aggregator parallèle ────────────────────────────────────────────────

export interface DashboardPayload {
  score: ScoreResponse;
  status: TenantStatusResponse;
  shadow: ShadowMarketingResponse;
}

export async function fetchDashboard(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<DashboardPayload> {
  const [score, status, shadow] = await Promise.all([
    fetchScore(workspaceId, opts),
    fetchTenantStatus(workspaceId, opts),
    fetchShadowMarketing(opts),
  ]);
  return { score, status, shadow };
}

// ─── Settings + credentials (U8) ──────────────────────────────────────────
//
// Miroir des handlers `veridian-bridge/src/settings/routes.ts`.
// Les creds VoIP ne sont JAMAIS renvoyés en clair — `masked` ne contient que
// des valeurs `••••1234`.

/** Kinds de credential VoIP supportés (cf credentials/providers.ts). */
export type CredentialKind = 'voip_ovh' | 'voip_telnyx';

export interface CredentialView {
  kind: CredentialKind;
  label: string;
  status: 'untested' | 'ok' | 'failed' | string;
  masked: Record<string, string>;
  lastSyncAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TenantSettingsResponse {
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

/** Patch partiel — seuls les champs fournis sont écrits. */
export interface SettingsUpdatePayload {
  notifyNewLead?: boolean;
  notifyWeeklyReport?: boolean;
  notifyEmail?: string | null;
  pushAdminEnabled?: boolean;
  visitorIdEnabled?: boolean;
  cookieConsentEnabled?: boolean;
}

export function fetchTenantSettings(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<TenantSettingsResponse> {
  return requestJson<TenantSettingsResponse>(
    `/api/admin/tenant/${encodeURIComponent(workspaceId)}/settings`,
    { method: 'GET', requireAdmin: true, signal: opts.signal },
  );
}

export function updateTenantSettings(
  workspaceId: string,
  patch: SettingsUpdatePayload,
): Promise<TenantSettingsResponse> {
  return requestJson<TenantSettingsResponse>(
    `/api/admin/tenant/${encodeURIComponent(workspaceId)}/settings`,
    { method: 'PUT', requireAdmin: true, body: patch },
  );
}

export function saveCredential(
  workspaceId: string,
  kind: CredentialKind,
  creds: Record<string, unknown>,
): Promise<{ ok: true; credential: CredentialView }> {
  return requestJson(
    `/api/admin/tenant/${encodeURIComponent(workspaceId)}/credentials`,
    { method: 'POST', requireAdmin: true, body: { kind, creds } },
  );
}

export function testCredential(
  workspaceId: string,
  kind: CredentialKind,
): Promise<{ ok: boolean; message: string; status: string }> {
  return requestJson(
    `/api/admin/tenant/${encodeURIComponent(
      workspaceId,
    )}/credentials/${encodeURIComponent(kind)}/test`,
    { method: 'POST', requireAdmin: true },
  );
}

export function deleteCredential(
  workspaceId: string,
  kind: CredentialKind,
): Promise<{ ok: true; deleted: boolean }> {
  return requestJson(
    `/api/admin/tenant/${encodeURIComponent(
      workspaceId,
    )}/credentials/${encodeURIComponent(kind)}`,
    { method: 'DELETE', requireAdmin: true },
  );
}
