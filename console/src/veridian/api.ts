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

async function fetchJson<T>(
  endpoint: string,
  opts: { requireAdmin?: boolean; signal?: AbortSignal } = {},
): Promise<T> {
  const url = `${bridgeBase()}${endpoint}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (opts.requireAdmin) {
    const key = adminKey();
    if (key) headers.Authorization = `Bearer ${key}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    credentials: 'same-origin',
    signal: opts.signal,
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

  return (await res.json()) as T;
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
