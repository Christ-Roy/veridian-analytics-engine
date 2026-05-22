/**
 * signedFetch — helper HTTP signé HMAC pour les tests d'intégration Hub.
 *
 * Les routes `/api/tenants/*` du bridge sont protégées par le middleware HMAC
 * (`hubHmacMiddleware`). Pour les appeler depuis un test d'intégration, il faut
 * poser les bons headers (`X-Veridian-Timestamp`, `X-Veridian-Hub-Signature`).
 *
 * Ce helper signe avec `TEST_HMAC_SECRET` par défaut. Les options permettent de
 * SIMULER une attaque (replay, tampering, mauvaise signature) — c'est T2 qui
 * s'en sert pour ses tests HMAC valide / replay / tamper.
 *
 * @example
 *   // requête signée correcte
 *   const res = await signedFetch(h.url, "POST", "/api/tenants/provision", {
 *     tenant_id: "tnt-1", owner_email: "a@b.com",
 *     workspace_name: "Acme", plan: "pro",
 *   });
 *
 *   // replay : timestamp vieux de 10 min → le middleware doit rejeter
 *   const replayed = await signedFetch(h.url, "POST", "/api/tenants/provision",
 *     body, { timestampOverride: Date.now() - 600_000 });
 *
 *   // body modifié après signature → signature invalide
 *   const tampered = await signedFetch(h.url, "POST", "/api/tenants/provision",
 *     body, { bodyAfterSign: '{"tenant_id":"evil"}' });
 */

import { signHubRequest } from "../../../src/hub-hmac.js";
import { TEST_HMAC_SECRET } from "./index.js";

export interface SignedFetchOptions {
  /** Secret utilisé pour signer. Default `TEST_HMAC_SECRET`. */
  secret?: string;
  /** Force un timestamp précis (test replay / horloge décalée). */
  timestampOverride?: number;
  /** Remplace la signature calculée par une valeur arbitraire (test tamper). */
  signatureOverride?: string;
  /** N'envoie pas le header timestamp (test header manquant). */
  omitTimestamp?: boolean;
  /** N'envoie pas le header signature (test header manquant). */
  omitSignature?: boolean;
  /** Body envoyé APRÈS signature — la signature ne matchera plus (test tamper). */
  bodyAfterSign?: string;
}

/**
 * Effectue une requête HTTP signée HMAC contre le bridge.
 *
 * @param baseUrl  `h.url` du harness.
 * @param method   `"POST"` | `"GET"` | ...
 * @param path     ex `/api/tenants/provision`.
 * @param body     objet sérialisé en JSON (signé sur les octets bruts).
 * @param opts     overrides pour simuler des attaques.
 */
export async function signedFetch(
  baseUrl: string,
  method: string,
  path: string,
  body: unknown,
  opts: SignedFetchOptions = {},
): Promise<Response> {
  const secret = opts.secret ?? TEST_HMAC_SECRET;
  const rawBody = body === undefined ? "" : JSON.stringify(body);
  const { timestamp, signature } = signHubRequest(
    rawBody,
    secret,
    opts.timestampOverride,
  );

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (!opts.omitTimestamp) headers["X-Veridian-Timestamp"] = timestamp;
  if (!opts.omitSignature) {
    headers["X-Veridian-Hub-Signature"] = opts.signatureOverride ?? signature;
  }

  return fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: method === "GET" ? undefined : (opts.bodyAfterSign ?? rawBody),
  });
}
