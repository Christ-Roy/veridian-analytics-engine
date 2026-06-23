/**
 * Registry des providers VoIP — schémas de creds, masquage, test de connexion.
 *
 * Port direct de `veridian-bridge/src/credentials/providers.ts` (logique pure,
 * zéro dépendance bridge). Chaque provider déclare :
 *   - `kind`            : identifiant stable stocké en DB (`voip_credentials.kind`)
 *   - sa forme de creds (champs attendus + validation pure)
 *   - `mask(creds)`     : vue masquée renvoyée par l'API (jamais le clear-text)
 *   - `testConnection(creds, fetchImpl)` : vérifie que les creds marchent
 *
 * Le sync (`voip-sync.service.ts`) pull les CDR via ces creds. Ce module ne
 * fait QUE : valider la saisie, masquer, tester la connexion.
 *
 * Validation : pure TypeScript (PAS de Zod — l'engine n'embarque pas zod et
 * valide en class-validator au niveau HTTP, cf `dto/voip.dto.ts`). Ici la
 * forme métier des creds (Record<string, unknown> opaque côté DTO) est validée
 * champ par champ, throw `VoipCredsValidationError` que le service catch en 400.
 *
 * Extensible : ajouter un provider = une entrée dans `VOIP_PROVIDERS`.
 */

import { createHash } from 'crypto';
import type { VoipCredentialKind } from './voip.types';

// ─── Erreur de validation des creds ─────────────────────────────────────────

/**
 * Levée par `provider.parse()` quand la saisie est invalide. Porte la liste
 * des problèmes (champ + raison) pour un message API lisible. Remplace
 * l'ancien `ZodError` (dépendance zod retirée).
 */
export class VoipCredsValidationError extends Error {
  constructor(public readonly issues: Array<{ field: string; message: string }>) {
    super(
      issues.map((i) => `${i.field} ${i.message}`).join('; ') ||
        'invalid credentials',
    );
    this.name = 'VoipCredsValidationError';
  }
}

/** Valide qu'une valeur est une string non vide dont la longueur ∈ [min, max]. */
function requireString(
  raw: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  issues: Array<{ field: string; message: string }>,
): string {
  const v = raw[field];
  if (typeof v !== 'string') {
    issues.push({ field, message: 'est requis (chaîne attendue)' });
    return '';
  }
  const trimmed = v.trim();
  if (trimmed.length < min) {
    issues.push({ field, message: `doit faire au moins ${min} caractère(s)` });
  }
  if (trimmed.length > max) {
    issues.push({ field, message: `doit faire au plus ${max} caractère(s)` });
  }
  return trimmed;
}

// ─── Formes de creds par provider ───────────────────────────────────────────

/** Endpoint OVH supporté. */
export type OvhEndpoint = 'ovh-eu' | 'ovh-ca' | 'ovh-us';
const OVH_ENDPOINTS: OvhEndpoint[] = ['ovh-eu', 'ovh-ca', 'ovh-us'];

/**
 * OVH Telephony — API OVH (https://eu.api.ovh.com/). Trois clés :
 *   - applicationKey    : clé de l'application OVH
 *   - applicationSecret : secret de l'application OVH
 *   - consumerKey       : consumer key (token tenant délivré par OVH)
 *   - endpoint          : eu / ca / us (défaut eu, FR)
 */
export interface OvhCreds {
  applicationKey: string;
  applicationSecret: string;
  consumerKey: string;
  endpoint: OvhEndpoint;
}

/**
 * Telnyx — API v2 (https://api.telnyx.com/v2/). Une seule clé :
 *   - apiKey : API key Telnyx (commence par `KEY...`)
 */
export interface TelnyxCreds {
  apiKey: string;
}

/** Type des creds en clair selon le kind. */
export type ClearCreds = OvhCreds | TelnyxCreds;

/** Parse + valide les creds OVH. Throw `VoipCredsValidationError` si invalide. */
function parseOvhCreds(raw: unknown): OvhCreds {
  if (typeof raw !== 'object' || raw === null) {
    throw new VoipCredsValidationError([{ field: 'creds', message: 'objet attendu' }]);
  }
  const obj = raw as Record<string, unknown>;
  const issues: Array<{ field: string; message: string }> = [];
  const applicationKey = requireString(obj, 'applicationKey', 1, 256, issues);
  const applicationSecret = requireString(obj, 'applicationSecret', 1, 256, issues);
  const consumerKey = requireString(obj, 'consumerKey', 1, 256, issues);
  let endpoint: OvhEndpoint = 'ovh-eu';
  if (obj.endpoint !== undefined && obj.endpoint !== null && obj.endpoint !== '') {
    if (
      typeof obj.endpoint !== 'string' ||
      !OVH_ENDPOINTS.includes(obj.endpoint as OvhEndpoint)
    ) {
      issues.push({
        field: 'endpoint',
        message: `doit valoir ${OVH_ENDPOINTS.join(' | ')}`,
      });
    } else {
      endpoint = obj.endpoint as OvhEndpoint;
    }
  }
  if (issues.length > 0) throw new VoipCredsValidationError(issues);
  return { applicationKey, applicationSecret, consumerKey, endpoint };
}

/** Parse + valide les creds Telnyx. Throw `VoipCredsValidationError` si invalide. */
function parseTelnyxCreds(raw: unknown): TelnyxCreds {
  if (typeof raw !== 'object' || raw === null) {
    throw new VoipCredsValidationError([{ field: 'creds', message: 'objet attendu' }]);
  }
  const obj = raw as Record<string, unknown>;
  const issues: Array<{ field: string; message: string }> = [];
  const apiKey = requireString(obj, 'apiKey', 8, 256, issues);
  if (issues.length > 0) throw new VoipCredsValidationError(issues);
  return { apiKey };
}

// ─── Masquage ───────────────────────────────────────────────────────────────

/**
 * Masque un secret : ne garde que les 4 derniers caractères.
 * Ex : `KEY0123456789abcdef` → `••••cdef`. Chaîne courte (<=4) → tout masqué.
 */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}

/** Résultat masqué renvoyé par l'API — JAMAIS de clear-text. */
export type MaskedCredential = Record<string, string>;

// ─── Endpoint OVH → host ────────────────────────────────────────────────────

const OVH_HOSTS: Record<OvhEndpoint, string> = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
};

/**
 * Timeout des requêtes du test de connexion (OVH /auth/time + /me, Telnyx
 * /balance). Le test est déclenché depuis une requête HTTP admin : sans timeout,
 * un provider lent gèlerait la requête utilisateur indéfiniment.
 */
const TEST_CONNECTION_TIMEOUT_MS = 12000;

// ─── Définition de provider ─────────────────────────────────────────────────

export interface ConnectionTestResult {
  ok: boolean;
  /** Message lisible — succès ("connecté à OVH …") ou cause d'échec. */
  message: string;
}

export interface ProviderDef<TCreds extends ClearCreds = ClearCreds> {
  kind: VoipCredentialKind;
  label: string;
  /** Parse + valide la saisie brute. Throw `VoipCredsValidationError` si invalide. */
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
  const host = OVH_HOSTS[creds.endpoint];
  const url = `${host}${path}`;
  // OVH veut un timestamp serveur — on récupère /auth/time (public, non signé).
  const timeRes = await fetchImpl(`${host}/auth/time`, {
    signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
  });
  const timestamp = timeRes.ok
    ? (await timeRes.text()).trim()
    : String(Math.floor(Date.now() / 1000));
  const body = '';
  const toSign = [
    creds.applicationSecret,
    creds.consumerKey,
    method,
    url,
    body,
    timestamp,
  ].join('+');
  const signature = '$1$' + createHash('sha1').update(toSign).digest('hex');
  return fetchImpl(url, {
    method,
    headers: {
      'X-Ovh-Application': creds.applicationKey,
      'X-Ovh-Consumer': creds.consumerKey,
      'X-Ovh-Timestamp': timestamp,
      'X-Ovh-Signature': signature,
      'Content-Type': 'application/json',
    },
    signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
  });
}

const ovhProvider: ProviderDef<OvhCreds> = {
  kind: 'voip_ovh',
  label: 'OVH Telephony',
  parse(raw) {
    return parseOvhCreds(raw);
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
      const res = await ovhSignedFetch(creds, 'GET', '/me', fetchImpl);
      if (res.ok) {
        return { ok: true, message: "Connecté à l'API OVH." };
      }
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message:
            'Credentials OVH refusés (401/403). Vérifiez applicationKey / applicationSecret / consumerKey et les droits du token.',
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
  kind: 'voip_telnyx',
  label: 'Telnyx',
  parse(raw) {
    return parseTelnyxCreds(raw);
  },
  mask(creds) {
    return { apiKey: maskSecret(creds.apiKey) };
  },
  async testConnection(creds, fetchImpl = fetch) {
    try {
      // GET /v2/balance — endpoint Telnyx léger qui valide l'API key.
      const res = await fetchImpl('https://api.telnyx.com/v2/balance', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${creds.apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      });
      if (res.ok) {
        return { ok: true, message: "Connecté à l'API Telnyx." };
      }
      if (res.status === 401) {
        return {
          ok: false,
          message: 'API key Telnyx refusée (401). Vérifiez la clé.',
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

export const VOIP_PROVIDERS: Record<VoipCredentialKind, ProviderDef> = {
  voip_ovh: ovhProvider as ProviderDef,
  voip_telnyx: telnyxProvider as ProviderDef,
};

export const VOIP_CREDENTIAL_KINDS: VoipCredentialKind[] = [
  'voip_ovh',
  'voip_telnyx',
];

export function isVoipCredentialKind(v: string): v is VoipCredentialKind {
  return v === 'voip_ovh' || v === 'voip_telnyx';
}

/** Récupère le provider d'un kind. Throw si kind inconnu. */
export function getProvider(kind: string): ProviderDef {
  if (!isVoipCredentialKind(kind)) {
    throw new Error(`unknown_credential_kind:${kind}`);
  }
  return VOIP_PROVIDERS[kind];
}

/** Map kind → provider VoIP normalisé. */
export function kindToProvider(kind: VoipCredentialKind): 'ovh' | 'telnyx' {
  return kind === 'voip_ovh' ? 'ovh' : 'telnyx';
}

/** Map provider VoIP → kind. */
export function providerToKind(
  provider: 'ovh' | 'telnyx',
): VoipCredentialKind {
  return provider === 'ovh' ? 'voip_ovh' : 'voip_telnyx';
}
