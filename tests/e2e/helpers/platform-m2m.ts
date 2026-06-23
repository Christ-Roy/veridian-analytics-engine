/**
 * Platform M2M helper — client typé pour l'API admin M2M native de l'engine
 * (`POST /api/admin/platform/*`, gated par PLATFORM_ADMIN_API_KEY).
 *
 * C'est LA surface que le gate E2E on-premise consomme : elle remplace
 * l'ancien micro-service bridge (décommissionné — `*-bridge.*.veridian.site`
 * répond 404). Tout passe désormais par des modules NestJS natifs.
 *
 * Pattern RPC : chaque endpoint est un POST `<verb>.<action>` avec un body
 * JSON, authentifié par `Authorization: Bearer <PLATFORM_ADMIN_API_KEY>`.
 *
 * Aucune dépendance externe : `fetch` natif + AbortController (timeout).
 */

import type { Target } from "./targets";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface M2MResponse {
  status: number;
  ok: boolean;
  body: string;
  json<T = unknown>(): T;
}

/**
 * Réponse de `tenants.provision`.
 * Source de vérité : api/src/admin-platform/dto/provision-tenant-response.dto.ts
 */
export interface ProvisionResult {
  workspace_id: string;
  owner_user_id: string;
  api_key: string; // stam_live_*
  snippet_html: string;
  dashboard_url: string;
  password_reset_url: string;
  phone_numbers: Array<{ e164: string; source: string; status: string }>;
  user_created: boolean;
}

/** Réponse de `tracking.verify`. */
export interface TrackingVerifyResult {
  workspace_id: string;
  workspace_exists: boolean;
  ingestion: { ok: boolean; round_trip_ms: number | null; detail: string };
  snippet: unknown | null;
  real_tracking: { sessions_30d: number; live: boolean };
  verdict:
    | "ok"
    | "ingestion_failed"
    | "snippet_missing"
    | "snippet_misconfigured"
    | "workspace_not_found";
}

/** Réponse de `workspaces.status`. */
export interface WorkspaceStatusResult {
  workspace_id: string;
  exists: boolean;
  name: string | null;
  status: string | null;
  tracking: { active: boolean; sessions_30d: number; live: boolean } | null;
  gsc: { connected: boolean } | null;
  voip: { configured: boolean; phone_number_count: number } | null;
  webhooks: { active_count: number } | null;
  snippet_html: string | null;
}

export class PlatformM2MClient {
  constructor(
    private readonly baseUrl: string,
    private readonly adminKey: string,
  ) {}

  /** True si une clé M2M est disponible (sinon le caller doit skip). */
  static fromEnv(target: Target): PlatformM2MClient | null {
    const key = process.env.PLATFORM_ADMIN_API_KEY;
    if (!key) return null;
    return new PlatformM2MClient(target.engineUrl, key);
  }

  async call(
    action: string,
    body: unknown,
    opts: { timeoutMs?: number } = {},
  ): Promise<M2MResponse> {
    const ctrl = new AbortController();
    const timeout = setTimeout(
      () => ctrl.abort(),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const res = await fetch(`${this.baseUrl}/api/admin/platform/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.adminKey}`,
          "X-E2E-Test-Run": process.env.GITHUB_RUN_ID || "local",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      return {
        status: res.status,
        ok: res.ok,
        body: text,
        json<T = unknown>(): T {
          try {
            return JSON.parse(text) as T;
          } catch {
            throw new Error(
              `M2M ${action} response not JSON: status=${res.status} body=${text.slice(0, 200)}`,
            );
          }
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Provision d'un tenant complet (workspace + owner + clé + snippet). */
  async provisionTenant(input: {
    email: string;
    siteUrl: string;
    name: string;
    workspace_id?: string;
    phoneNumbers?: Array<{ e164: string; source: string }>;
  }): Promise<{ status: number; data: ProvisionResult }> {
    const res = await this.call("tenants.provision", input);
    if (res.status !== 200 && res.status !== 201) {
      throw new Error(
        `tenants.provision failed status=${res.status} body=${res.body.slice(0, 300)}`,
      );
    }
    return { status: res.status, data: res.json<ProvisionResult>() };
  }

  workspaceStatus(workspaceId: string): Promise<M2MResponse> {
    return this.call("workspaces.status", { workspace_id: workspaceId });
  }

  trackingVerify(
    workspaceId: string,
    siteUrl?: string,
  ): Promise<M2MResponse> {
    return this.call("tracking.verify", {
      workspace_id: workspaceId,
      ...(siteUrl ? { site_url: siteUrl } : {}),
    });
  }

  analyticsQuery(
    workspaceId: string,
    metrics: string[],
    preset = "previous_30_days",
  ): Promise<M2MResponse> {
    return this.call("analytics.query", {
      workspace_id: workspaceId,
      metrics,
      dateRange: { preset },
    });
  }

  voipAddPhoneNumber(
    workspaceId: string,
    e164: string,
    source: string,
  ): Promise<M2MResponse> {
    return this.call("voip.addPhoneNumber", {
      workspace_id: workspaceId,
      e164,
      source,
    });
  }

  voipListPhoneNumbers(workspaceId: string): Promise<M2MResponse> {
    return this.call("voip.listPhoneNumbers", { workspace_id: workspaceId });
  }

  gscStatus(workspaceId: string): Promise<M2MResponse> {
    return this.call("gsc.status", { workspace_id: workspaceId });
  }
}

/**
 * Cleanup d'un workspace de test via super-admin JWT (`workspaces.delete`).
 *
 * Le delete n'est PAS exposé en M2M (par design : c'est une action user-scoped
 * gated par WorkspaceAuthGuard + permission workspace.delete). Un super-admin
 * peut supprimer n'importe quel workspace (cf workspace.guard.ts §"Super admins
 * can access any workspace"). On se logge donc avec E2E_ADMIN_EMAIL/PASSWORD
 * (creds staging super-admin) pour purger le workspace jetable.
 *
 * Best-effort : si pas de creds ou si le delete échoue, on log mais on ne fail
 * pas le test — le workspace E2E jetable (préfixe e2e_gate_) reste identifiable
 * et inerte, jamais un workspace client réel.
 */
export async function deleteWorkspaceAsSuperAdmin(
  target: Target,
  workspaceId: string,
): Promise<{ deleted: boolean; reason?: string }> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    return { deleted: false, reason: "no E2E_ADMIN creds" };
  }
  try {
    const loginRes = await fetch(`${target.consoleUrl}/api/auth.login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!loginRes.ok) {
      return { deleted: false, reason: `login ${loginRes.status}` };
    }
    const { access_token } = (await loginRes.json()) as {
      access_token: string;
    };
    const delRes = await fetch(`${target.consoleUrl}/api/workspaces.delete`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${access_token}`,
      },
      body: JSON.stringify({ id: workspaceId }),
      signal: AbortSignal.timeout(25_000),
    });
    return delRes.ok
      ? { deleted: true }
      : { deleted: false, reason: `delete ${delRes.status}` };
  } catch (err) {
    return {
      deleted: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
