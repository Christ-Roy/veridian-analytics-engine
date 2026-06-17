/**
 * Client fetch GSC — consomme désormais le MODULE NATIF de l'engine
 * (`GET /api/gsc/dashboard`, `GET /api/gsc/status`, `POST /api/gsc/oauth-begin`,
 * `POST /api/gsc/resync`, `POST /api/gsc/disconnect`).
 *
 * Avant : le bridge Express (`{bridge}/api/admin/tenant/:ws/gsc`, Bearer admin
 * global). Après le port natif (migration v9), GSC vit dans l'engine et
 * s'authentifie comme tout le reste de la console staminads : JWT workspace en
 * `localStorage` (header Authorization), même origine que la console. Plus de
 * `VITE_VERIDIAN_BRIDGE_URL` ni de clé admin globale.
 *
 * La shape `GscDashboardResponse` est INCHANGÉE → les composants UI
 * (search-console-panel, kpi-tile, charts, data-table) ne bougent pas.
 */

import { BridgeApiError } from '../api';
import type { GscDashboardResponse } from './types';

/** État de connexion GSC renvoyé par `GET /api/gsc/status`. */
export interface GscStatusResponse {
  connected: boolean;
  site_url: string | null;
  ownership_state: 'pending' | 'verified' | null;
  last_sync_at: string | null;
}

/**
 * Appel authentifié natif engine : JWT workspace en localStorage, même origine.
 * Conserve `BridgeApiError` comme type d'erreur pour ne pas toucher aux
 * composants UI qui le catchent déjà (le nom reste, la sémantique aussi).
 */
async function engineRequest<T>(
  endpoint: string,
  opts: {
    method?: 'GET' | 'POST';
    body?: unknown;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const token = localStorage.getItem('token');
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(endpoint, {
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
    const msg =
      typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : typeof body === 'object' && body && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`;
    throw new BridgeApiError(msg, res.status, endpoint);
  }
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

/**
 * Résumé GSC (totals, topQueries, topPages, timeseries) sur `days` jours.
 * Si le workspace n'a pas connecté GSC, l'engine répond 200 avec
 * `property: null` → l'UI affiche l'onboarding.
 */
export async function fetchGscDashboard(
  workspaceId: string,
  days: number,
  opts: { signal?: AbortSignal } = {},
): Promise<GscDashboardResponse> {
  const endpoint = `/api/gsc/dashboard?workspace_id=${encodeURIComponent(
    workspaceId,
  )}&days=${encodeURIComponent(String(days))}`;
  return engineRequest<GscDashboardResponse>(endpoint, { signal: opts.signal });
}

/** État de la connexion GSC du workspace (remplace le bloc `settings.gsc`). */
export async function fetchGscStatus(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<GscStatusResponse> {
  const endpoint = `/api/gsc/status?workspace_id=${encodeURIComponent(
    workspaceId,
  )}`;
  return engineRequest<GscStatusResponse>(endpoint, { signal: opts.signal });
}

/** Démarre le flow OAuth Google et renvoie l'URL de consentement à ouvrir. */
export async function fetchGscOauthBeginUrl(
  workspaceId: string,
): Promise<string> {
  const data = await engineRequest<{ url: string }>('/api/gsc/oauth-begin', {
    method: 'POST',
    body: { workspace_id: workspaceId },
  });
  return data.url;
}

/** Resynchronise immédiatement les données GSC. */
export async function triggerGscResync(workspaceId: string): Promise<void> {
  await engineRequest('/api/gsc/resync', {
    method: 'POST',
    body: { workspace_id: workspaceId },
  });
}

/** Déconnecte la propriété GSC (purge le token chiffré). */
export async function disconnectGsc(workspaceId: string): Promise<void> {
  await engineRequest('/api/gsc/disconnect', {
    method: 'POST',
    body: { workspace_id: workspaceId },
  });
}
