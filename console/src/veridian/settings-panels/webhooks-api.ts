/**
 * Client fetch Webhooks / Connecteurs — endpoints NATIFS de l'engine
 * (`/api/webhooks.*`).
 *
 * Self-config des connecteurs depuis la console (ticket 2026-06-17) : le panel
 * Settings « Connecteurs » pilote le module `webhooks` de l'engine (CRUD
 * destinations, connecteur Twenty natif, test, deliveries + retry). Avant ce
 * panel, brancher un Twenty exigeait l'API M2M en CLI/script.
 *
 * Auth : `WorkspaceAuthGuard` + `@RequirePermission('webhook.*')` côté engine.
 * On consomme la session console (`Authorization: Bearer <localStorage token>`,
 * comme tout le reste de la console staminads — cf `console/src/lib/api.ts`).
 * Pas de clé admin globale, pas de Bearer M2M côté navigateur.
 *
 * SÉCURITÉ — secret write-only : le Bearer Twenty (`auth.token`) est chiffré
 * AES-256-GCM côté engine et n'est JAMAIS renvoyé. Les réponses exposent
 * uniquement `auth: { type, has_secret }`. Ce client envoie le token à la
 * création / mise à jour, ne le lit jamais, ne le stocke jamais.
 */

// ─── Types miroir du contrat backend ────────────────────────────────────────

export type WebhookAuthType = 'none' | 'bearer' | 'basic' | 'hmac';

export type WebhookTransformType = 'passthrough' | 'template' | 'twenty';

export type DeliveryStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'retrying'
  | 'gave_up';

/** Transform renvoyé / envoyé. Pour un connecteur Twenty : `{ type: 'twenty', dry_run }`. */
export interface WebhookTransform {
  type: WebhookTransformType;
  /** Template Handlebars (type='template' uniquement). */
  template?: string;
  /** Gate à blanc Twenty (type='twenty' uniquement) : mutations loguées, lectures réelles. */
  dry_run?: boolean;
}

export interface WebhookRetryConfig {
  max_attempts: number;
  backoff_ms: number[];
}

/**
 * Webhook tel que renvoyé par l'API (`PublicWebhookDefinition`). Le secret
 * chiffré est masqué : on n'a que `auth.type` + `auth.has_secret`.
 */
export interface PublicWebhook {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  active: boolean;
  auth_type: WebhookAuthType;
  auth: {
    type: WebhookAuthType;
    /** Indique qu'un secret est stocké — la valeur n'est jamais renvoyée. */
    has_secret: boolean;
  };
  events: string[];
  filters: unknown[];
  transform: WebhookTransform | null;
  retry_config: WebhookRetryConfig;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  workspace_id: string;
  event_id: string;
  event_type: string;
  attempt: number;
  scheduled_at: string;
  sent_at: string | null;
  status: DeliveryStatus;
  http_status: number | null;
  latency_ms: number | null;
  request_url: string;
  request_body: string;
  response_body: string;
  error_message: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookEventType {
  type: string;
  description: string;
}

/** Résultat inline de `webhooks.test` (livraison synchrone). */
export interface WebhookTestResult {
  delivery_id: string;
  success: boolean;
  http_status: number | null;
  latency_ms: number | null;
  response_body: string;
  error_message: string;
}

/** Bloc auth envoyé à la création / mise à jour. Le token est write-only. */
export interface WebhookAuthInput {
  type: WebhookAuthType;
  /** Secret en clair envoyé une seule fois ; chiffré côté engine, jamais relu. */
  token?: string;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  active?: boolean;
  auth?: WebhookAuthInput;
  events: string[];
  transform?: WebhookTransform;
}

export interface UpdateWebhookInput {
  name?: string;
  url?: string;
  active?: boolean;
  /** Présent uniquement si l'utilisateur change le secret / le type d'auth. */
  auth?: WebhookAuthInput;
  events?: string[];
  transform?: WebhookTransform;
}

/** Erreur typée (conserve le status HTTP + le `code` NestJS pour les cas 400/404/409). */
export class WebhookApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'WebhookApiError';
    this.status = status;
    this.code = code;
  }
}

type HttpMethod = 'GET' | 'POST';

/**
 * Appel JSON natif engine. Réutilise le contrat d'auth de la console
 * staminads (`Authorization: Bearer <localStorage token>`). Les erreurs
 * NestJS renvoient `{ code?, message }` — on remonte le `code` quand présent
 * (ex. `DUPLICATE_NAME`, `WEBHOOK_NOT_FOUND`) pour que l'UI traduise.
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
    throw new WebhookApiError(message, res.status, obj.code ?? null);
  }

  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

// ─── CRUD destinations ──────────────────────────────────────────────────────

export function listWebhooks(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<PublicWebhook[]> {
  return request<PublicWebhook[]>(
    `webhooks.list?workspace_id=${encodeURIComponent(workspaceId)}`,
    { method: 'GET', signal: opts.signal },
  );
}

export function createWebhook(
  workspaceId: string,
  input: CreateWebhookInput,
): Promise<PublicWebhook> {
  return request<PublicWebhook>('webhooks.create', {
    method: 'POST',
    body: { workspace_id: workspaceId, ...input },
  });
}

export function updateWebhook(
  workspaceId: string,
  id: string,
  patch: UpdateWebhookInput,
): Promise<PublicWebhook> {
  return request<PublicWebhook>('webhooks.update', {
    method: 'POST',
    body: { workspace_id: workspaceId, id, ...patch },
  });
}

export function deleteWebhook(
  workspaceId: string,
  id: string,
): Promise<{ success: true }> {
  return request('webhooks.delete', {
    method: 'POST',
    body: { workspace_id: workspaceId, id },
  });
}

// ─── Test synchrone ─────────────────────────────────────────────────────────

export function testWebhook(
  workspaceId: string,
  id: string,
): Promise<WebhookTestResult> {
  return request<WebhookTestResult>('webhooks.test', {
    method: 'POST',
    body: { workspace_id: workspaceId, id },
  });
}

// ─── Deliveries ─────────────────────────────────────────────────────────────

export function listDeliveries(
  workspaceId: string,
  opts: {
    webhookId?: string;
    status?: DeliveryStatus;
    limit?: number;
    signal?: AbortSignal;
  } = {},
): Promise<WebhookDelivery[]> {
  const params = new URLSearchParams({ workspace_id: workspaceId });
  if (opts.webhookId) params.set('webhook_id', opts.webhookId);
  if (opts.status) params.set('status', opts.status);
  if (opts.limit) params.set('limit', String(opts.limit));
  return request<WebhookDelivery[]>(
    `webhooks.deliveries.list?${params.toString()}`,
    { method: 'GET', signal: opts.signal },
  );
}

export function retryDelivery(
  workspaceId: string,
  deliveryId: string,
): Promise<{ success: boolean; delivery_id: string }> {
  return request('webhooks.deliveries.retry', {
    method: 'POST',
    body: { workspace_id: workspaceId, delivery_id: deliveryId },
  });
}

// ─── Catalogue d'événements (V1 — hardcodé côté engine) ───────────────────────

export function listEventTypes(
  workspaceId: string,
  opts: { signal?: AbortSignal } = {},
): Promise<WebhookEventType[]> {
  return request<{ events: WebhookEventType[] }>(
    `webhooks.events?workspace_id=${encodeURIComponent(workspaceId)}`,
    { method: 'GET', signal: opts.signal },
  ).then((r) => r.events);
}
