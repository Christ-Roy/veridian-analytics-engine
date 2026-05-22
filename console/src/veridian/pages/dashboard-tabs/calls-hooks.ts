import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchCalls, BridgeApiError, type CallsResponse } from '../../api';

/**
 * Hook `useCalls` — alimente le tab Calls du dashboard Veridian (U9).
 *
 * Consomme `GET /api/admin/tenant/:wsId/calls?days=N` (endpoint livré par le
 * ticket B-VOIP). Gère explicitement le cas où l'endpoint n'existe pas encore
 * (B-VOIP non mergé) ou n'est pas branché :
 *
 *   - HTTP 404           → état `not-connected` (téléphonie pas branchée),
 *                          PAS une erreur rouge. L'UI propose un CTA Settings.
 *   - 200 voipConnected=false → idem `not-connected`.
 *   - 200 voipConnected=true  → état `ready` avec les données.
 *   - 401 / 403 / 5xx / réseau → état `error` (carte erreur + retry).
 *
 * Le 404 traité comme « non branché » est volontaire : tant que B-VOIP n'a pas
 * livré sa route, le bridge répond 404 sur `/calls` — et on veut que le tab
 * affiche un onboarding propre, pas un message d'incident.
 */

export type UseCallsState =
  | { kind: 'loading' }
  | { kind: 'not-connected' }
  | { kind: 'error'; error: Error }
  | { kind: 'ready'; data: CallsResponse };

export interface UseCallsResult {
  state: UseCallsState;
  /** Relance le fetch (bouton « Réessayer »). */
  reload: () => void;
}

export function useCalls(
  workspaceId: string,
  days: number,
): UseCallsResult {
  const [state, setState] = useState<UseCallsState>({ kind: 'loading' });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setState({ kind: 'loading' });

    fetchCalls(workspaceId, days, { signal: ctrl.signal })
      .then((data) => {
        if (ctrl.signal.aborted) return;
        if (!data.voipConnected) {
          setState({ kind: 'not-connected' });
          return;
        }
        setState({ kind: 'ready', data });
      })
      .catch((err: Error) => {
        if (ctrl.signal.aborted) return;
        // Endpoint pas encore livré (B-VOIP non mergé) → onboarding propre.
        if (err instanceof BridgeApiError && err.status === 404) {
          setState({ kind: 'not-connected' });
          return;
        }
        setState({ kind: 'error', error: err });
      });
  }, [workspaceId, days]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  return { state, reload: load };
}

// ─── Helpers de formatage ────────────────────────────────────────────────

/**
 * Formate une durée en secondes en `m:ss` (ou `h:mm:ss` au-delà d'une heure).
 */
export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec <= 0) return '0:00';
  const sec = Math.round(totalSec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * Formate une date ISO en libellé court fr-FR (`12 mai · 14:32`).
 */
export function formatCallDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'short',
  }).format(d);
  const time = new Intl.DateTimeFormat('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return `${date} · ${time}`;
}
