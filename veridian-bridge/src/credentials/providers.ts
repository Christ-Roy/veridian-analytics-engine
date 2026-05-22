/**
 * Providers VoIP supportés par les credentials self-service (U8).
 *
 * Chaque provider déclare :
 *   - `kind`            : identifiant stable stocké en DB (`TenantCredential.kind`)
 *   - sa forme de creds (champs attendus + validation Zod)
 *   - `mask(creds)`     : vue masquée renvoyée par l'API (jamais le clear-text)
 *   - `testConnection(creds, fetchImpl)` : vérifie que les creds marchent
 *
 * Le bridge a un cron (ticket B-VOIP séparé) qui pull les call logs via ces
 * creds. Ce module ne fait QUE : valider la saisie, masquer, tester la
 * connexion. Le pull de logs n'est PAS ici.
 *
 * Extensible : ajouter un provider = une entrée dans `PROVIDERS`.
 */

import { z } from "zod";

// ─── Kinds supportés ────────────────────────────────────────────────────────

export const CREDENTIAL_KINDS = ["voip_ovh", "voip_telnyx"] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export function isCredentialKind(v: string): v is CredentialKind {
  return (CREDENTIAL_KINDS as readonly string[]).includes(v);
}

// ─── Schemas de creds par provider ──────────────────────────────────────────

/**
 * OVH Telephony — API OVH (https://eu.api.ovh.com/). Trois clés :
 *   - applicationKey    : clé de l'application OVH
 *   - applicationSecret : secret de l'application OVH
 *   - consumerKey       : consumer key (token tenant délivré par OVH)
 */
export const OvhCredsSchema = z.object({
  applicationKey: z.string().trim().min(1).max(256),
  applicationSecret: z.string().trim().min(1).max(256),
  consumerKey: z.string().trim().min(1).max(256),
  /** Endpoint OVH — eu / ca / us. Défaut eu (FR). */
  endpoint: z.enum(["ovh-eu", "ovh-ca", "ovh-us"]).default("ovh-eu"),
});
export type OvhCreds = z.infer<typeof OvhCredsSchema>;

/**
 * Telnyx — API v2 (https://api.telnyx.com/v2/). Une seule clé :
 *   - apiKey : API key Telnyx (commence par `KEY...`)
 */
export const TelnyxCredsSchema = z.object({
  apiKey: z.string().trim().min(8).max(256),
});
export type TelnyxCreds = z.infer<typeof TelnyxCredsSchema>;

// ─── Masquage ───────────────────────────────────────────────────────────────

/**
 * Masque un secret : ne garde que les 4 derniers caractères.
 * Ex : `KEY0123456789abcdef` → `••••cdef`. Chaîne courte (<=4) → tout masqué.
 */
export function maskSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "••••";
  return "••••" + value.slice(-4);
}

/** Résultat masqué renvoyé par l'API — JAMAIS de clear-text. */
export type MaskedCredential = Record<string, string>;

/** Type des creds en clair selon le kind. */
export type ClearCreds = OvhCreds | TelnyxCreds;

// ─── Endpoint OVH → host ────────────────────────────────────────────────────

const OVH_HOSTS: Record<OvhCreds["endpoint"], string> = {
  "ovh-eu": "https://eu.api.ovh.com/1.0",
  "ovh-ca": "https://ca.api.ovh.com/1.0",
  "ovh-us": "https://api.us.ovhcloud.com/1.0",
};

// ─── Définition de provider ─────────────────────────────────────────────────

export interface ConnectionTestResult {
  ok: boolean;
  /** Message lisible — succès ("connecté à OVH …") ou cause d'échec. */
  message: string;
}

export interface ProviderDef<TCreds extends ClearCreds = ClearCreds> {
  kind: CredentialKind;
  label: string;
  /** Parse + valide la saisie brute. Throw ZodError si invalide. */
  parse(raw: unknown): TCreds;
  /** Vue masquée — c'est ce que l'API renvoie. */
  mask(creds: TCreds): MaskedCredential;
  /** Teste que les creds marchent contre l'API du provider. */
  testConnection(
    creds: TCreds,
    fetchImpl?: typeof fetch,
  ): Promise<ConnectionTestResult>;
}

// ─── OVH ────────────────────────────────────────────────────────────────────

/**
 * Signe une requête OVH (algo OVH : sha1 de
 * appSecret+consumerKey+METHOD+URL+BODY+TIMESTAMP).
 */
async function ovhSignedFetch(
  creds: OvhCreds,
  method: string,
  path: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const { createHash } = await import("node:crypto");
  const host = OVH_HOSTS[creds.endpoint];
  const url = `${host}${path}`;
  // OVH veut un timestamp serveur — on récupère /auth/time (public, non signé).
  const timeRes = await fetchImpl(`${host}/auth/time`);
  const timestamp = timeRes.ok
    ? (await timeRes.text()).trim()
    : String(Math.floor(Date.now() / 1000));
  const body = "";
  const toSign = [
    creds.applicationSecret,
    creds.consumerKey,
    method,
    url,
    body,
    timestamp,
  ].join("+");
  const signature =
    "$1$" + createHash("sha1").update(toSign).digest("hex");
  return fetchImpl(url, {
    method,
    headers: {
      "X-Ovh-Application": creds.applicationKey,
      "X-Ovh-Consumer": creds.consumerKey,
      "X-Ovh-Timestamp": timestamp,
      "X-Ovh-Signature": signature,
      "Content-Type": "application/json",
    },
  });
}

const ovhProvider: ProviderDef<OvhCreds> = {
  kind: "voip_ovh",
  label: "OVH Telephony",
  parse(raw) {
    return OvhCredsSchema.parse(raw);
  },
  mask(creds) {
    return {
      applicationKey: maskSecret(creds.applicationKey),
      applicationSecret: maskSecret(creds.applicationSecret),
      consumerKey: maskSecret(creds.consumerKey),
      endpoint: creds.endpoint,
    };
  },
  async testConnection(creds, fetchImpl = fetch) {
    try {
      // GET /me — endpoint OVH minimal qui requiert un consumerKey valide.
      const res = await ovhSignedFetch(creds, "GET", "/me", fetchImpl);
      if (res.ok) {
        return { ok: true, message: "Connecté à l'API OVH." };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message:
            "Credentials OVH refusés (401/403). Vérifie applicationKey / applicationSecret / consumerKey et les droits du token.",
        };
      }
      return {
        ok: false,
        message: `OVH a répondu HTTP ${res.status}.`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `Connexion OVH impossible : ${(err as Error).message}`,
      };
    }
  },
};

// ─── Telnyx ─────────────────────────────────────────────────────────────────

const telnyxProvider: ProviderDef<TelnyxCreds> = {
  kind: "voip_telnyx",
  label: "Telnyx",
  parse(raw) {
    return TelnyxCredsSchema.parse(raw);
  },
  mask(creds) {
    return { apiKey: maskSecret(creds.apiKey) };
  },
  async testConnection(creds, fetchImpl = fetch) {
    try {
      // GET /v2/balance — endpoint Telnyx léger qui valide l'API key.
      const res = await fetchImpl("https://api.telnyx.com/v2/balance", {
        method: "GET",
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          Accept: "application/json",
        },
      });
      if (res.ok) {
        return { ok: true, message: "Connecté à l'API Telnyx." };
      }
      if (res.status === 401) {
        return {
          ok: false,
          message: "API key Telnyx refusée (401). Vérifie la clé.",
        };
      }
      return {
        ok: false,
        message: `Telnyx a répondu HTTP ${res.status}.`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `Connexion Telnyx impossible : ${(err as Error).message}`,
      };
    }
  },
};

// ─── Registry ───────────────────────────────────────────────────────────────

export const PROVIDERS: Record<CredentialKind, ProviderDef> = {
  voip_ovh: ovhProvider as ProviderDef,
  voip_telnyx: telnyxProvider as ProviderDef,
};

/** Récupère le provider d'un kind. Throw si kind inconnu. */
export function getProvider(kind: string): ProviderDef {
  if (!isCredentialKind(kind)) {
    throw new Error(`unknown_credential_kind:${kind}`);
  }
  return PROVIDERS[kind];
}
