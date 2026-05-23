/**
 * HMAC Hub helper — pour signer des requêtes vers le bridge Veridian.
 *
 * Reproduction de l'algo dans `veridian-bridge/src/hub-hmac.ts` :
 *   - Header `X-Veridian-Timestamp` = unix ms en string
 *   - Header `X-Veridian-Hub-Signature` = hex(HMAC-SHA256(secret, `${ts}.${rawBody}`))
 *   - Anti-replay : reject si |now - ts| > 5min
 *
 * IMPORTANT : on signe le RAW body (string utf-8 exact qu'on enverra). Si
 * on JSON.stringify() ailleurs, la sig est foutue.
 */

import crypto from "node:crypto";

export interface SignedHeaders {
  "X-Veridian-Timestamp": string;
  "X-Veridian-Hub-Signature": string;
  "Content-Type": string;
}

/**
 * Signe une payload Hub → bridge.
 *
 * @param rawBody  le string exact qu'on va POST (typically JSON.stringify)
 * @param secret   le secret HMAC partagé (HUB_HMAC_SECRET sur le bridge)
 * @param now      override clock pour tester anti-replay (ms unix)
 */
export function signHubRequest(
  rawBody: string,
  secret: string,
  now?: number,
): SignedHeaders {
  const ts = String(now ?? Date.now());
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${ts}.${rawBody}`, "utf8")
    .digest("hex");
  return {
    "X-Veridian-Timestamp": ts,
    "X-Veridian-Hub-Signature": signature,
    "Content-Type": "application/json",
  };
}

/**
 * POST signé vers le bridge.
 */
export async function postSignedToBridge(
  bridgeUrl: string,
  path: string,
  body: unknown,
  secret: string,
  opts: { timestampOverride?: number; signatureOverride?: string } = {},
): Promise<Response> {
  const rawBody = JSON.stringify(body);
  const headers = signHubRequest(rawBody, secret, opts.timestampOverride);
  if (opts.signatureOverride !== undefined) {
    headers["X-Veridian-Hub-Signature"] = opts.signatureOverride;
  }
  return fetch(`${bridgeUrl}${path}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

/**
 * GET signé vers le bridge (les endpoints HMAC GET utilisent body="" comme raw).
 */
export async function getSignedFromBridge(
  bridgeUrl: string,
  path: string,
  secret: string,
): Promise<Response> {
  const headers = signHubRequest("", secret);
  return fetch(`${bridgeUrl}${path}`, {
    method: "GET",
    headers,
  });
}
