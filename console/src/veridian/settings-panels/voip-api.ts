/**
 * Client fetch VoIP — endpoints NATIFS de l'engine (`/api/voip.*`).
 *
 * Port natif (option A, ticket 2026-06-16) : le panel Settings VoIP ne tape
 * PLUS le bridge. Il consomme les routes natives de l'engine, authentifiées
 * par la session console (JWT `Bearer <localStorage token>`, comme tout le
 * reste de la console staminads — cf `console/src/lib/api.ts`).
 *
 * Auth : `WorkspaceAuthGuard` + `@RequirePermission('voip.*')` côté engine.
 * Pas de `VITE_VERIDIAN_ADMIN_KEY`, pas de Bearer admin global.
 *
 * PAS de liste d'appels : la vision Robert (2026-05-23) bannit la page Calls.
 * Les appels remontent comme events `phone_call` natifs (Live/Explore/Goals).
 * Ce client ne gère que la CONFIG : credentials + numéros trackés + statut.
 */

export type VoipCredentialKind = 'voip_ovh' | 'voip_telnyx';

export type PhoneSource =
  | 'seo'
  | 'ads'
  | 'direct'
  | 'email'
  | 'social'
  | 'print'
  | 'other';

export interface CredentialView {
  kind: VoipCredentialKind;
  label: string;
  status: 'untested' | 'ok' | 'failed' | string;
  masked: Record<string, string>;
  lastSyncAt: string | null;
  lastTestedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TrackedPhoneNumber {
  id: string;
  e164: string;
  source: PhoneSource;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Réponse agrégée de `GET /api/voip.settings`. */
export interface VoipSettingsResponse {
  credentials: CredentialView[];
  phoneNumbers: TrackedPhoneNumber[];
  allowedSources: PhoneSource[];
}

/** Erreur typée (conserve le status HTTP pour les cas 404/409). */
export class VoipApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'VoipApiError';
    this.status = status;
    this.code = code;
  }
}

type HttpMethod = 'GET' | 'POST';

/**
 * Appel JSON natif engine. Réutilise le contrat d'auth de la console
 * staminads (`Authorization: Bearer <localStorage token>`). Les erreurs
 * NestJS renvoient `{ code?, message }` — on remonte le `code` quand présent
 * (ex. `invalid_e164`, `already_exists`) pour que l'UI traduise.
 */
async function request<T>(
  endpoint: string,
  opts: { method?: HttpMethod; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const token =
    typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api/${endpoint}`, {
    method: opts.method ?? 'GET',
    headers,
    signal: opts.signal,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const obj = (body ?? {}) as { code?: string; message?: string | string[] };
    const message = Array.isArray(obj.message)
      ? obj.message[0]
      : obj.message ?? `HTTP ${res.status}`;
    throw new VoipApiError(message, res.status, obj.code ?? null);
  }

  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

// ─── Settings agrégé ────────────────────────────────────────────────────

export function fetchVoipSettings(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<VoipSettingsResponse> {
  return request<VoipSettingsResponse>(
    `voip.settings?workspace_id=${encodeURIComponent(workspaceId)}`,
    { method: 'GET', signal: opts.signal },
  );
}

// ─── Credentials ────────────────────────────────────────────────────────

export function saveCredential(
  workspaceId: string,
  kind: VoipCredentialKind,
  creds: Record<string, unknown>,
): Promise<{ ok: true; credential: CredentialView }> {
  return request('voip.saveCredential', {
    method: 'POST',
    body: { workspace_id: workspaceId, kind, creds },
  });
}

export function testCredential(
  workspaceId: string,
  kind: VoipCredentialKind,
): Promise<{ ok: boolean; message: string; status: string }> {
  return request('voip.testCredential', {
    method: 'POST',
    body: { workspace_id: workspaceId, kind },
  });
}

export function deleteCredential(
  workspaceId: string,
  kind: VoipCredentialKind,
): Promise<{ ok: true; deleted: boolean }> {
  return request('voip.deleteCredential', {
    method: 'POST',
    body: { workspace_id: workspaceId, kind },
  });
}

// ─── Numéros trackés (1 numéro = 1 source) ────────────────────────────────

export interface PhoneNumbersListResponse {
  phoneNumbers: TrackedPhoneNumber[];
  allowedSources: PhoneSource[];
}

export function fetchPhoneNumbers(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PhoneNumbersListResponse> {
  return request<PhoneNumbersListResponse>(
    `voip.listPhoneNumbers?workspace_id=${encodeURIComponent(workspaceId)}`,
    { method: 'GET', signal: opts.signal },
  );
}

export function createPhoneNumber(
  workspaceId: string,
  body: { e164: string; source: PhoneSource; label?: string | null },
): Promise<{ ok: true; phoneNumber: TrackedPhoneNumber }> {
  return request('voip.createPhoneNumber', {
    method: 'POST',
    body: { workspace_id: workspaceId, ...body },
  });
}

export function updatePhoneNumber(
  workspaceId: string,
  id: string,
  patch: { source?: PhoneSource; label?: string | null },
): Promise<{ ok: true; phoneNumber: TrackedPhoneNumber }> {
  return request('voip.updatePhoneNumber', {
    method: 'POST',
    body: { workspace_id: workspaceId, id, ...patch },
  });
}

export function deletePhoneNumber(
  workspaceId: string,
  id: string,
): Promise<{ ok: true; deleted: boolean }> {
  return request('voip.deletePhoneNumber', {
    method: 'POST',
    body: { workspace_id: workspaceId, id },
  });
}
