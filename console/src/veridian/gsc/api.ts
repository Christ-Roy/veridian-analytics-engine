/**
 * Client fetch GSC dashboard — consomme l'endpoint bridge
 * `GET /api/admin/tenant/:workspaceId/gsc?days=N` livré par A4.
 *
 * Wrapper minimal autour du helper `requestJson` partagé : on garde la
 * gestion d'erreurs unifiée (`BridgeApiError`) et l'auth Bearer admin.
 */

import { BridgeApiError } from '../api';
import type { GscDashboardResponse } from './types';

function bridgeBase(): string {
  const env = (import.meta as ImportMeta).env as Record<string, string | undefined>;
  return env?.VITE_VERIDIAN_BRIDGE_URL ?? '';
}

function adminKey(): string {
  const env = (import.meta as ImportMeta).env as Record<string, string | undefined>;
  return env?.VITE_VERIDIAN_ADMIN_KEY ?? '';
}

/**
 * Récupère le résumé GSC (totals, topQueries, topPages, timeseries) pour
 * une fenêtre de `days` jours. Si le tenant n'a pas connecté GSC, le bridge
 * répond 200 avec `property: null` — l'UI affiche alors l'onboarding.
 */
export async function fetchGscDashboard(
  workspaceId: string,
  days: number,
  opts: { signal?: AbortSignal } = {},
): Promise<GscDashboardResponse> {
  const endpoint = `/api/admin/tenant/${encodeURIComponent(
    workspaceId,
  )}/gsc?days=${encodeURIComponent(String(days))}`;
  const url = `${bridgeBase()}${endpoint}`;
  const key = adminKey();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;

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

  return (await res.json()) as GscDashboardResponse;
}
