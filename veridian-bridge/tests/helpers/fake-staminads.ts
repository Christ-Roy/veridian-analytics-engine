/**
 * Faux serveur staminads pour tests d'intégration du bridge.
 *
 * Le bridge appelle staminads via HTTP. Pour tester en isolation sans docker,
 * on monte un vrai serveur HTTP local qui imite les endpoints staminads utilisés :
 *   - GET  /api/setup.status
 *   - POST /api/setup.initialize
 *   - POST /api/auth.login
 *   - POST /api/workspaces.create
 *   - POST /api/apiKeys.create
 *   - POST /api/track
 *   - POST /api/analytics.query
 *
 * Chaque test peut configurer le comportement (succès, erreur 500, body custom)
 * via setBehavior() avant d'appeler le bridge.
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
  setupCompleted?: boolean;
  initializeStatus?: number;
  initializeBody?: unknown;
  loginStatus?: number;
  loginBody?: unknown;
  workspaceCreateStatus?: number;
  workspaceCreateBody?: unknown;
  apiKeyCreateStatus?: number;
  apiKeyCreateBody?: unknown;
  trackStatus?: number;
  trackBody?: unknown;
  analyticsStatus?: number;
  analyticsBody?: unknown;
}

const DEFAULT_BEHAVIOR: Required<Behavior> = {
  setupCompleted: false,
  initializeStatus: 201,
  initializeBody: { access_token: "fake-admin-token-from-init", user: { id: "u1" } },
  loginStatus: 200,
  loginBody: { access_token: "fake-admin-token-from-login" },
  workspaceCreateStatus: 201,
  workspaceCreateBody: { id: "ws_fake_abc", name: "Test WS" },
  apiKeyCreateStatus: 201,
  apiKeyCreateBody: { id: "key_fake_xyz", key: "sk_live_fake_apikey_for_tests" },
  trackStatus: 200,
  trackBody: { success: true },
  analyticsStatus: 200,
  analyticsBody: { rows: [{ utm_source: "veridian-poc", pageviews: 3, sessions: 1 }] },
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

    if (path === "/api/setup.status" && req.method === "GET") {
      this.send(res, 200, { setupCompleted: this.behavior.setupCompleted });
      return;
    }
    if (path === "/api/setup.initialize" && req.method === "POST") {
      this.send(res, this.behavior.initializeStatus, this.behavior.initializeBody);
      return;
    }
    if (path === "/api/auth.login" && req.method === "POST") {
      this.send(res, this.behavior.loginStatus, this.behavior.loginBody);
      return;
    }
    if (path === "/api/workspaces.create" && req.method === "POST") {
      this.send(
        res,
        this.behavior.workspaceCreateStatus,
        this.behavior.workspaceCreateBody
      );
      return;
    }
    if (path === "/api/apiKeys.create" && req.method === "POST") {
      this.send(res, this.behavior.apiKeyCreateStatus, this.behavior.apiKeyCreateBody);
      return;
    }
    if (path === "/api/track" && req.method === "POST") {
      this.send(res, this.behavior.trackStatus, this.behavior.trackBody);
      return;
    }
    if (path === "/api/analytics.query" && req.method === "POST") {
      this.send(res, this.behavior.analyticsStatus, this.behavior.analyticsBody);
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
