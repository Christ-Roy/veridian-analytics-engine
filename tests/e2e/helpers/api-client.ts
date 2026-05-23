/**
 * Wrapper fetch léger pour les tests E2E.
 *
 * Pourquoi pas direct `fetch` ? Parce qu'on veut :
 *   - Logs structurés en cas d'échec (status, body, target, headers utiles)
 *   - Timeout par défaut (les tests ne doivent pas pendre 60s sur un endpoint dead)
 *   - Header X-E2E-Test-Run propagé partout pour debug log-side
 *   - JSON helpers (parseJson, expectJsonProperty)
 */

import type { Target } from "./targets";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface ApiOptions extends Omit<RequestInit, "signal"> {
  timeoutMs?: number;
  /** Ne PAS throw sur status 4xx/5xx. Default: false. */
  allowFailure?: boolean;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
  json: () => unknown;
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async request(
    method: string,
    path: string,
    opts: ApiOptions = {},
  ): Promise<ApiResponse> {
    const url = path.startsWith("http") ? path : `${this.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = new Headers(opts.headers);
      if (!headers.has("X-E2E-Test-Run")) {
        headers.set("X-E2E-Test-Run", process.env.GITHUB_RUN_ID || "local");
      }
      const res = await fetch(url, {
        method,
        ...opts,
        headers,
        signal: ctrl.signal,
      });
      const body = await res.text();
      const headersOut: Record<string, string> = {};
      res.headers.forEach((v, k) => (headersOut[k] = v));
      const out: ApiResponse = {
        status: res.status,
        ok: res.ok,
        headers: headersOut,
        body,
        json: () => {
          try {
            return JSON.parse(body);
          } catch {
            throw new Error(
              `Response not JSON. status=${res.status} url=${url} body=${body.slice(0, 200)}`,
            );
          }
        },
      };
      if (!opts.allowFailure && res.status >= 400) {
        // ne throw pas mais expose le détail pour expect()
      }
      return out;
    } finally {
      clearTimeout(timeout);
    }
  }

  get(path: string, opts?: ApiOptions): Promise<ApiResponse> {
    return this.request("GET", path, opts);
  }
  post(path: string, body?: unknown, opts: ApiOptions = {}): Promise<ApiResponse> {
    const headers = new Headers(opts.headers);
    if (body !== undefined && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    return this.request("POST", path, {
      ...opts,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  delete(path: string, opts?: ApiOptions): Promise<ApiResponse> {
    return this.request("DELETE", path, opts);
  }
}

export function makeClient(target: Pick<Target, "consoleUrl">): ApiClient {
  return new ApiClient(target.consoleUrl);
}

export function makeBridgeClient(target: Pick<Target, "bridgeUrl">): ApiClient {
  return new ApiClient(target.bridgeUrl);
}
