/**
 * Faux serveur Engine (Staminads fork) pour tests d'intégration du bridge.
 *
 * Depuis la migration M2M (2026-06-16, retrait de l'anti-pattern getAdminToken),
 * le bridge ne parle PLUS à l'Engine via un login super_admin
 * (setup.status / setup.initialize / auth.login / workspaces.create /
 * apiKeys.create). Il tape les endpoints M2M natifs (Bearer
 * PLATFORM_ADMIN_API_KEY) :
 *   - POST /api/admin/platform/tenants.provision
 *   - POST /api/admin/platform/workspaces.provisionApiKey
 *   - POST /api/admin/platform/analytics.query
 *   - POST /api/track  (collecte d'events, inchangé)
 *
 * Chaque test configure le comportement (succès, erreur, body custom) via
 * setBehavior() avant d'appeler le bridge.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}

export interface Behavior {
  /** POST /api/admin/platform/tenants.provision */
  provisionStatus?: number;
  provisionBody?: unknown;
  /** POST /api/admin/platform/workspaces.provisionApiKey */
  provisionApiKeyStatus?: number;
  provisionApiKeyBody?: unknown;
  /** POST /api/track */
  trackStatus?: number;
  trackBody?: unknown;
  /** POST /api/admin/platform/analytics.query — réponse NATIVE { data, meta } */
  analyticsStatus?: number;
  analyticsBody?: unknown;
  /**
   * Réponse analytics routée par `table` (sessions/goals). Le score fait 2
   * queries (une par table) → permet de renvoyer des data différentes. Si la
   * table demandée n'a pas d'override ici, on retombe sur `analyticsBody`.
   */
  analyticsBodyByTable?: Partial<Record<"sessions" | "pages" | "goals", unknown>>;
}

const DEFAULT_BEHAVIOR: Required<Behavior> = {
  provisionStatus: 201,
  provisionBody: {
    workspace_id: "ws_fake_abc",
    owner_user_id: "u1",
    api_key: "sk_live_fake_apikey_for_tests",
    snippet_html: '<script src="x"></script>',
    dashboard_url: "https://analytics-engine.app.veridian.site/workspaces/ws_fake_abc",
    password_reset_url: "https://analytics-engine.app.veridian.site/reset-password/tok",
    phone_numbers: [],
    user_created: true,
  },
  provisionApiKeyStatus: 201,
  provisionApiKeyBody: {
    workspace_id: "ws_fake_abc",
    api_key: "sk_live_fake_apikey_refreshed",
    key_prefix: "sk_live_f",
  },
  trackStatus: 200,
  trackBody: { success: true },
  analyticsStatus: 200,
  // Format natif : { data: [...] } (PAS le legacy { rows: [...] }).
  analyticsBody: {
    data: [{ utm_source: "veridian-poc", pageviews: 3, sessions: 1 }],
    meta: { total_rows: 1 },
  },
  analyticsBodyByTable: {},
};

export class FakeStaminads {
  private server: Server;
  private behavior: Required<Behavior> = { ...DEFAULT_BEHAVIOR };
  private calls: RecordedCall[] = [];
  public url = "";

  constructor() {
    this.server = createServer((req, res) => this.handle(req, res));
  }

  async start(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as AddressInfo;
        this.url = `http://127.0.0.1:${addr.port}`;
        resolve(this.url);
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  setBehavior(b: Behavior): void {
    this.behavior = { ...DEFAULT_BEHAVIOR, ...b };
  }

  resetBehavior(): void {
    this.behavior = { ...DEFAULT_BEHAVIOR };
  }

  getCalls(): RecordedCall[] {
    return [...this.calls];
  }

  resetCalls(): void {
    this.calls = [];
  }

  private async readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return undefined;
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const url = req.url ?? "";
    const path = url.split("?")[0];

    this.calls.push({
      method: req.method ?? "GET",
      path,
      headers: { ...req.headers },
      body,
    });

    if (
      path === "/api/admin/platform/tenants.provision" &&
      req.method === "POST"
    ) {
      this.send(res, this.behavior.provisionStatus, this.behavior.provisionBody);
      return;
    }
    if (
      path === "/api/admin/platform/workspaces.provisionApiKey" &&
      req.method === "POST"
    ) {
      this.send(
        res,
        this.behavior.provisionApiKeyStatus,
        this.behavior.provisionApiKeyBody,
      );
      return;
    }
    if (
      path === "/api/admin/platform/analytics.query" &&
      req.method === "POST"
    ) {
      const table = (body as { table?: "sessions" | "pages" | "goals" } | undefined)
        ?.table;
      const override =
        table && this.behavior.analyticsBodyByTable[table] !== undefined
          ? this.behavior.analyticsBodyByTable[table]
          : this.behavior.analyticsBody;
      this.send(res, this.behavior.analyticsStatus, override);
      return;
    }
    if (path === "/api/track" && req.method === "POST") {
      this.send(res, this.behavior.trackStatus, this.behavior.trackBody);
      return;
    }

    this.send(res, 404, { error: "fake_not_implemented", path });
  }
}

/**
 * Démarre l'app Express bridge sur un port aléatoire local et retourne son URL.
 * Utilisé par les tests pour faire des fetch() réels vers le bridge.
 */
export async function startAppOnEphemeralPort(
  app: import("express").Express
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) => srv.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}
