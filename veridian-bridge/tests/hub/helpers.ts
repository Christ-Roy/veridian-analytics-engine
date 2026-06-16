/**
 * Helpers communs aux tests Hub HMAC.
 *
 * - createHubBridge() : démarre une app sur un port éphémère, store en mémoire,
 *   secret HMAC partagé. Renvoie url + store + close + secret.
 * - signedFetch()     : POST/GET signé HMAC (timestamp + signature corrects).
 */

import { createApp, type BridgeConfig } from "../../src/app.js";
import { signHubRequest } from "../../src/hub-hmac.js";
import { InMemoryTenantStore } from "../../src/hub/store.js";
import { startAppOnEphemeralPort } from "../helpers/fake-staminads.js";

export const TEST_SECRET = "veridian-hub-test-secret-32chars!";
export const ADMIN_KEY = "veridian-test-admin-key-32-chars!";

export interface HubBridgeFixture {
  url: string;
  close: () => Promise<void>;
  store: InMemoryTenantStore;
  /** Hook staminads par défaut (renvoie des ids fixes). */
  staminadsCalls: Array<{
    hubTenantId: string;
    workspaceName: string;
    ownerEmail: string;
  }>;
  resetStaminadsCalls(): void;
}

export interface HubBridgeOpts {
  skipHmac?: boolean;
  staminadsImpl?: BridgeConfig["hub"] extends infer H
    ? H extends { createStaminadsWorkspace?: infer F }
      ? F
      : never
    : never;
  store?: InMemoryTenantStore;
  loadStats?: BridgeConfig["hub"] extends infer H
    ? H extends { loadStats?: infer F }
      ? F
      : never
    : never;
}

export async function createHubBridge(
  opts: HubBridgeOpts = {}
): Promise<HubBridgeFixture> {
  const store = opts.store ?? new InMemoryTenantStore();
  const staminadsCalls: HubBridgeFixture["staminadsCalls"] = [];
  let counter = 0;

  const defaultStaminads = async (input: {
    hubTenantId: string;
    workspaceName: string;
    ownerEmail: string;
  }) => {
    staminadsCalls.push({ ...input });
    counter += 1;
    return {
      workspaceId: `ws_fake_${counter}`,
      apiKey: `sk_fake_${counter}_${input.hubTenantId.slice(0, 8)}`,
    };
  };

  const app = createApp({
    staminadsUrl: "http://127.0.0.1:9", // jamais touché grâce au hook
      platformAdminApiKey: "veridian-test-platform-key-32-chars!!",
    veridianAdminApiKey: ADMIN_KEY,
    hub: {
      hmacSecret: TEST_SECRET,
      skipHmac: opts.skipHmac,
      store,
      createStaminadsWorkspace: opts.staminadsImpl ?? defaultStaminads,
      loadStats: opts.loadStats,
    },
  });

  const started = await startAppOnEphemeralPort(app);
  return {
    url: started.url,
    close: started.close,
    store,
    staminadsCalls,
    resetStaminadsCalls: () => {
      staminadsCalls.length = 0;
    },
  };
}

export async function signedFetch(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
  opts: {
    secret?: string;
    timestampOverride?: number;
    signatureOverride?: string;
    omitTimestamp?: boolean;
    omitSignature?: boolean;
    bodyAfterSign?: string;
  } = {}
): Promise<Response> {
  const secret = opts.secret ?? TEST_SECRET;
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const { timestamp, signature } = signHubRequest(
    rawBody,
    secret,
    opts.timestampOverride
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!opts.omitTimestamp) {
    headers["X-Veridian-Timestamp"] = timestamp;
  }
  if (!opts.omitSignature) {
    headers["X-Veridian-Hub-Signature"] = opts.signatureOverride ?? signature;
  }

  const finalBody = opts.bodyAfterSign ?? rawBody;
  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : finalBody,
  });
}
