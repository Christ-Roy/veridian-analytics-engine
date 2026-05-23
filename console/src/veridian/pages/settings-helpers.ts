/**
 * Helpers de la page Settings (U8) extraits pour rester testables.
 *
 * `fetchOauthBeginUrl` : appelle `POST /api/admin/gsc/oauth-begin` du bridge
 * et retourne l'URL Google consent à ouvrir. Le bridge attend un `tenantId`
 * (l'id interne du Tenant côté bridge) — mais la console ne connaît que le
 * `workspaceId` staminads. On résout d'abord le tenant via l'endpoint
 * settings, qui renvoie `tenant.id`.
 *
 * Note : `oauth-begin` prend `tenantId` en query param (cf gsc/routes.ts).
 */

import { fetchTenantSettings, BridgeApiError } from '../api';

interface OauthBeginResponse {
  url: string;
  state: string;
  tenantId: string;
}

function bridgeBase(): string {
  const env = (import.meta as ImportMeta).env as Record<
    string,
    string | undefined
  >;
  return env?.VITE_VERIDIAN_BRIDGE_URL ?? '';
}

function adminKey(): string {
  const env = (import.meta as ImportMeta).env as Record<
    string,
    string | undefined
  >;
  return env?.VITE_VERIDIAN_ADMIN_KEY ?? '';
}

async function adminRequest(
  endpoint: string,
  method: 'GET' | 'POST' | 'DELETE' = 'POST',
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = adminKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  return fetch(`${bridgeBase()}${endpoint}`, {
    method,
    headers,
    credentials: 'same-origin',
  });
}

async function parseError(res: Response, endpoint: string): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = '';
  }
  throw new BridgeApiError(
    typeof body === 'object' && body && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`,
    res.status,
    endpoint,
  );
}

/**
 * Démarre le flow OAuth GSC pour un workspace et renvoie l'URL Google à
 * ouvrir. Throw `BridgeApiError` si le bridge refuse (GSC non configuré,
 * tenant introuvable, auth).
 */
export async function fetchOauthBeginUrl(
  workspaceId: string,
): Promise<string> {
  // 1. Résout l'id interne du tenant via l'endpoint settings.
  const settings = await fetchTenantSettings(workspaceId);
  const tenantId = settings.tenant.id;

  // 2. POST oauth-begin?tenantId=...
  const endpoint = `/api/admin/gsc/oauth-begin?tenantId=${encodeURIComponent(
    tenantId,
  )}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  const key = adminKey();
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${bridgeBase()}${endpoint}`, {
    method: 'POST',
    headers,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = '';
    }
    throw new BridgeApiError(
      typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`,
      res.status,
      endpoint,
    );
  }
  const data = (await res.json()) as OauthBeginResponse;
  return data.url;
}

/**
 * Resynchronise immédiatement les données Search Console pour un workspace.
 *
 * Le bridge expose `POST /api/admin/gsc/sync?gscPropertyId=...` — on récupère
 * d'abord la propriété rattachée au tenant via l'endpoint settings, puis on
 * déclenche le sync. Si le bridge n'a pas la route (ancienne version), on
 * remonte le 404 proprement à l'UI.
 */
export async function triggerGscResync(workspaceId: string): Promise<void> {
  const settings = await fetchTenantSettings(workspaceId);
  if (!settings.gsc.connected || !settings.gsc.propertyUrl) {
    throw new BridgeApiError(
      'Search Console non connecté pour ce workspace.',
      400,
      '/api/admin/gsc/sync',
    );
  }
  // Le bridge attend un `gscPropertyId` (id interne) — on passe l'URL en
  // fallback si l'id n'est pas disponible côté response settings.
  const propertyId =
    (settings.gsc as { propertyId?: string }).propertyId ??
    settings.gsc.propertyUrl;
  const endpoint = `/api/admin/gsc/sync?gscPropertyId=${encodeURIComponent(
    propertyId,
  )}&days=7`;
  const res = await adminRequest(endpoint, 'POST');
  if (!res.ok) await parseError(res, endpoint);
}

/**
 * Déconnecte la propriété Search Console d'un workspace. Le bridge expose
 * `DELETE /api/admin/tenant/:workspaceId/gsc` — si l'endpoint n'existe pas
 * (404), l'UI affiche une erreur explicite.
 */
export async function disconnectGsc(workspaceId: string): Promise<void> {
  const endpoint = `/api/admin/tenant/${encodeURIComponent(workspaceId)}/gsc`;
  const res = await adminRequest(endpoint, 'DELETE');
  if (!res.ok) await parseError(res, endpoint);
}
