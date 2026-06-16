/**
 * Client M2M natif Engine (Staminads fork) — remplace l'anti-pattern
 * `getAdminToken` (super_admin email/password + JWT caché 6j).
 *
 * AVANT (anti-pattern, cf. audit AUDIT-COMMERCIAL-2026-05-25 §1/§82/§288) :
 *   le bridge se loguait avec un compte super_admin (setup.initialize /
 *   auth.login) pour obtenir un JWT, puis tapait workspaces.create /
 *   apiKeys.create / analytics.query avec ce JWT. Credentials de service en
 *   clair dans Dokploy, rotation du password = casse silencieuse, pas d'audit.
 *
 * APRÈS (ce module) : un SEUL secret partagé M2M `PLATFORM_ADMIN_API_KEY`
 * (Bearer, timing-safe côté `PlatformAdminGuard`) tape les endpoints natifs
 * `/api/admin/platform/*` :
 *   - tenants.provision        → crée workspace + user owner + apiKey + magic link
 *   - workspaces.provisionApiKey → (re)génère une apiKey sur un workspace existant
 *   - analytics.query          → lit l'analytics de n'importe quel workspace
 *
 * Aucune logique métier ici : c'est un client HTTP fin. La validation
 * (métriques par table, existence workspace, etc.) vit côté Engine.
 */

/** Source acquisition d'un numéro (doit matcher `PhoneSource` côté Engine). */
export type PhoneSource =
  | "seo"
  | "ads"
  | "direct"
  | "email"
  | "social"
  | "print"
  | "other";

export interface ProvisionTenantInput {
  email: string;
  siteUrl: string;
  name: string;
  /**
   * Optionnel : id de workspace explicite (migration D2 qui adopte un id
   * legacy). Si absent, l'Engine slugifie `name`. Doit matcher
   * `^[a-z][a-z0-9_]*$` (2..50).
   */
  workspace_id?: string;
  timezone?: string;
  currency?: string;
  phoneNumbers?: Array<{ e164: string; source: PhoneSource }>;
}

export interface ProvisionTenantResult {
  workspace_id: string;
  owner_user_id: string;
  api_key: string;
  snippet_html: string;
  dashboard_url: string;
  password_reset_url: string;
  phone_numbers: Array<{
    e164: string;
    source: string;
    status: string;
    error?: string;
  }>;
  user_created: boolean;
}

export interface ProvisionApiKeyResult {
  workspace_id: string;
  api_key: string;
  key_prefix: string;
}

/**
 * Forme native d'une query analytics (DTO `AnalyticsQueryDto` côté Engine).
 * NB : contrat natif = `dateRange.preset` (PAS le legacy `{type}`), métriques
 * limitées à UNE table par query (sessions OU goals), dimensions valides
 * (`day`/`month`/… — il n'existe PAS de dimension `date`).
 */
export interface AnalyticsQueryInput {
  workspace_id: string;
  metrics: string[];
  dimensions?: string[];
  dateRange: {
    preset?: string;
    start?: string;
    end?: string;
    granularity?: string;
  };
  table?: "sessions" | "goals";
  timezone?: string;
  limit?: number;
}

/**
 * Réponse native analytics : `{ data, meta, query }` (PAS le legacy `{rows}`).
 * On ne type que `data` ici — c'est tout ce que les fetchers bridge lisent.
 */
export interface AnalyticsQueryResult {
  data: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
}

export class EngineM2mError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "EngineM2mError";
  }
}

export interface EngineM2mClientOptions {
  /** Base URL de l'Engine (interne Docker en runtime, ex http://engine:3000). */
  engineUrl: string;
  /** Clé M2M partagée Hub/bridge ↔ Engine (Bearer PLATFORM_ADMIN_API_KEY). */
  platformAdminApiKey: string;
  /** Injectable pour les tests (défaut : global fetch). */
  fetchImpl?: typeof fetch;
}

export interface EngineM2mClient {
  provisionTenant(input: ProvisionTenantInput): Promise<ProvisionTenantResult>;
  provisionApiKey(input: {
    workspace_id: string;
    name?: string;
    role?: "admin" | "editor" | "viewer";
  }): Promise<ProvisionApiKeyResult>;
  analyticsQuery(input: AnalyticsQueryInput): Promise<AnalyticsQueryResult>;
}

/**
 * Construit un client M2M Engine. Toutes les requêtes portent le header
 * `Authorization: Bearer <platformAdminApiKey>`. Aucun cache de token :
 * l'auth M2M est une clé statique, pas un JWT court-vécu à rafraîchir.
 */
export function createEngineM2mClient(
  opts: EngineM2mClientOptions,
): EngineM2mClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = opts.engineUrl.replace(/\/$/, "");

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.platformAdminApiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new EngineM2mError(
        `engine M2M ${path} failed: ${res.status}`,
        res.status,
        text,
      );
    }
    return (await res.json()) as T;
  }

  return {
    provisionTenant(input) {
      return post<ProvisionTenantResult>(
        "/api/admin/platform/tenants.provision",
        input,
      );
    },
    provisionApiKey(input) {
      return post<ProvisionApiKeyResult>(
        "/api/admin/platform/workspaces.provisionApiKey",
        input,
      );
    },
    analyticsQuery(input) {
      return post<AnalyticsQueryResult>(
        "/api/admin/platform/analytics.query",
        input,
      );
    },
  };
}
