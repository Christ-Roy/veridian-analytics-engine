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
