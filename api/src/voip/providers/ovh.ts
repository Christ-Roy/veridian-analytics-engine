/**
 * Client API OVH Telephony — pull des call logs (CDR).
 *
 * Port direct de `veridian-bridge/src/voip/providers/ovh.ts` (logique pure
 * fetch + crypto SHA1, zéro dépendance bridge).
 *
 * Les credentials OVH (`OvhCreds`) ne portent QUE
 * `{ applicationKey, applicationSecret, consumerKey, endpoint }` — pas de
 * billingAccount ni de serviceName. On les DÉCOUVRE depuis l'API OVH :
 *
 *   1. GET /telephony                              → billingAccounts du compte
 *   2. GET /telephony/{ba}/service                 → lignes (serviceName) du BA
 *   3. GET /telephony/{ba}/service/{sn}/voiceConsumption       → ids de consos
 *   4. GET /telephony/{ba}/service/{sn}/voiceConsumption/{id}  → détail conso
 *
 * → Zéro champ supplémentaire à demander au tenant : la saisie (3 clés OVH)
 * suffit à pull TOUS les call logs de TOUTES ses lignes.
 *
 * Auth OVH : signature
 *   "$1$" + sha1("{appSecret}+{consumerKey}+{METHOD}+{URL}+{BODY}+{TIMESTAMP}")
 * envoyée dans X-Ovh-Application / X-Ovh-Consumer / X-Ovh-Timestamp /
 * X-Ovh-Signature. Le timestamp serveur vient de /auth/time.
 *
 * Docs : https://api.ovh.com/ — section /telephony.
 */

import { createHash } from 'crypto';
import type { OvhCreds } from '../voip.providers';
import {
  VoipApiError,
  type CallDirection,
  type CallStatus,
  type FetchCdrOptions,
  type NormalizedCall,
} from '../voip.types';

/** endpoint OVH → host API (mêmes valeurs que `voip.providers.ts`). */
const OVH_HOSTS: Record<OvhCreds['endpoint'], string> = {
  'ovh-eu': 'https://eu.api.ovh.com/1.0',
  'ovh-ca': 'https://ca.api.ovh.com/1.0',
  'ovh-us': 'https://api.us.ovhcloud.com/1.0',
};

/** Plafond d'appels détaillés par ligne et par sync — évite 10k consos. */
const MAX_CONSUMPTIONS_PER_LINE = 2000;
/** Plafond de lignes traitées par compte — garde-fou. */
const MAX_LINES = 200;
/**
 * Timeout par requête HTTP vers OVH. Le `fetch` global Node n'a PAS de timeout
 * par défaut : un TCP black-hole côté provider gèlerait le sync À VIE (le flag
 * `running` de VoipSyncService ne serait jamais relâché → arrêt silencieux de
 * TOUTE l'ingestion d'appels). On borne donc chaque call.
 */
const OVH_REQUEST_TIMEOUT_MS = 15000;
/**
 * Re-signature périodique : la signature OVH embarque un timestamp serveur et
 * OVH tolère ~30s de dérive. Sur un pull multi-lignes (jusqu'à
 * MAX_LINES × MAX_CONSUMPTIONS_PER_LINE = 400k GET), réutiliser le même
 * timestamp ferait échouer les requêtes tardives en `401 OVH:QUERY_TIME_OUT`.
 * On re-fetch /auth/time toutes les ~20s d'horloge écoulée.
 */
const OVH_RESIGN_INTERVAL_MS = 20000;

/** Forme brute d'une voiceConsumption OVH (champs qu'on consomme). */
interface OvhVoiceConsumption {
  consumptionId?: number;
  /** "incoming" | "outgoing". */
  wayType?: string;
  calling?: string;
  called?: string;
  /** durée en secondes. */
  duration?: number;
  /** ISO date du début de l'appel. */
  creationDatetime?: string;
}

/** Résout le host API depuis l'endpoint (défaut eu si inattendu). */
function hostFor(creds: OvhCreds): string {
  return OVH_HOSTS[creds.endpoint] ?? OVH_HOSTS['ovh-eu'];
}

/** Signe une requête OVH. Retourne les headers d'auth. */
function signOvhRequest(opts: {
  creds: OvhCreds;
  method: string;
  url: string;
  body: string;
  timestamp: number;
}): Record<string, string> {
  const { creds, method, url, body, timestamp } = opts;
  const toSign = `${creds.applicationSecret}+${creds.consumerKey}+${method}+${url}+${body}+${timestamp}`;
  const signature = '$1$' + createHash('sha1').update(toSign).digest('hex');
  return {
    'X-Ovh-Application': creds.applicationKey,
    'X-Ovh-Consumer': creds.consumerKey,
    'X-Ovh-Timestamp': String(timestamp),
    'X-Ovh-Signature': signature,
    'Content-Type': 'application/json',
  };
}

/** Récupère le temps serveur OVH (epoch secondes). */
async function fetchOvhTime(
  host: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const res = await fetchImpl(`${host}/auth/time`, {
    method: 'GET',
    signal: AbortSignal.timeout(OVH_REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new VoipApiError(
      `ovh_auth_time_failed status=${res.status}`,
      res.status,
      'ovh',
    );
  }
  const t = (await res.text()).trim();
  const n = Number(t);
  if (!Number.isFinite(n)) {
    throw new VoipApiError('ovh_auth_time_unparseable', 502, 'ovh');
  }
  return n;
}

/**
 * Contexte de signature OVH qui se ré-aligne sur l'heure serveur. Garde un
 * timestamp serveur frais et le re-fetch quand il dérive de plus de
 * `OVH_RESIGN_INTERVAL_MS` (mesuré sur l'horloge locale). Évite à la fois le
 * coût d'un /auth/time par requête ET les `401 QUERY_TIME_OUT` d'un timestamp
 * réutilisé sur des centaines de milliers de GET.
 */
class OvhSigner {
  private serverTime: number; // epoch secondes côté OVH
  private fetchedAtMonotonic: number; // Date.now() local au moment du fetch

  private constructor(serverTime: number) {
    this.serverTime = serverTime;
    this.fetchedAtMonotonic = Date.now();
  }

  static async create(host: string, fetchImpl: typeof fetch): Promise<OvhSigner> {
    return new OvhSigner(await fetchOvhTime(host, fetchImpl));
  }

  /** Renvoie un timestamp serveur frais, re-synchronisé si trop vieux. */
  private async timestamp(host: string, fetchImpl: typeof fetch): Promise<number> {
    const elapsed = Date.now() - this.fetchedAtMonotonic;
    if (elapsed >= OVH_RESIGN_INTERVAL_MS) {
      this.serverTime = await fetchOvhTime(host, fetchImpl);
      this.fetchedAtMonotonic = Date.now();
      return this.serverTime;
    }
    // Avance le timestamp serveur de l'écoulé local (reste dans la tolérance OVH).
    return this.serverTime + Math.floor(elapsed / 1000);
  }

  /** GET signé sur l'API OVH, avec timestamp re-synchronisé au besoin. */
  async get<T>(host: string, path: string, creds: OvhCreds, fetchImpl: typeof fetch): Promise<T> {
    const url = `${host}${path}`;
    const timestamp = await this.timestamp(host, fetchImpl);
    const headers = signOvhRequest({
      creds,
      method: 'GET',
      url,
      body: '',
      timestamp,
    });
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(OVH_REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new VoipApiError(
        `ovh_get_failed path=${path} status=${res.status} body=${txt.slice(0, 200)}`,
        res.status,
        'ovh',
      );
    }
    return (await res.json()) as T;
  }
}

/** Mappe `wayType` OVH → direction normalisée. */
function mapDirection(wayType: string | undefined): CallDirection {
  return wayType === 'outgoing' ? 'outbound' : 'inbound';
}

/**
 * Déduit un statut depuis la conso OVH. OVH ne donne pas de champ "status"
 * direct dans voiceConsumption : durée 0 = non abouti (missed), sinon
 * answered. On reste conservateur (pas de busy/failed distinct faute de
 * signal fiable côté OVH consumption).
 */
function mapStatus(duration: number | undefined): CallStatus {
  return (duration ?? 0) > 0 ? 'answered' : 'missed';
}

/** Normalise une voiceConsumption OVH → NormalizedCall. */
export function normalizeOvhConsumption(
  c: OvhVoiceConsumption,
): NormalizedCall | null {
  if (c.consumptionId === undefined || c.consumptionId === null) return null;
  const startedAt = c.creationDatetime
    ? new Date(c.creationDatetime)
    : new Date(0);
  return {
    externalId: String(c.consumptionId),
    direction: mapDirection(c.wayType),
    fromNumber: c.calling ?? '',
    toNumber: c.called ?? '',
    durationSec: Math.max(0, Math.round(c.duration ?? 0)),
    status: mapStatus(c.duration),
    recordingUrl: null, // OVH expose les records via une autre API (non couvert)
    startedAt,
  };
}

/** Pull les CDR d'UNE ligne (billingAccount + serviceName). */
async function fetchLineCdr(
  host: string,
  billingAccount: string,
  serviceName: string,
  creds: OvhCreds,
  signer: OvhSigner,
  since: Date,
  until: Date,
  fetchImpl: typeof fetch,
): Promise<NormalizedCall[]> {
  const base = `/telephony/${encodeURIComponent(billingAccount)}/service/${encodeURIComponent(serviceName)}/voiceConsumption`;
  const ids = await signer.get<number[]>(host, base, creds, fetchImpl);
  if (!Array.isArray(ids)) {
    throw new VoipApiError('ovh_unexpected_consumption_list', 502, 'ovh');
  }
  // Cap APRÈS tri par récence : `consumptionId` OVH est monotone croissant
  // (id plus grand = conso plus récente), donc trier décroissant puis capper
  // garde les appels LES PLUS RÉCENTS. L'ancien `ids.slice(0, MAX)` tronquait
  // dans l'ordre brut de l'API (non garanti chronologique) → on pouvait perdre
  // les appels récents au profit des plus vieux. Le filtre date reste appliqué
  // par-détail (le seul endroit où OVH expose `creationDatetime`).
  const capped = [...ids]
    .sort((a, b) => b - a)
    .slice(0, MAX_CONSUMPTIONS_PER_LINE);
  const calls: NormalizedCall[] = [];
  for (const id of capped) {
    let detail: OvhVoiceConsumption;
    try {
      detail = await signer.get<OvhVoiceConsumption>(
        host,
        `${base}/${id}`,
        creds,
        fetchImpl,
      );
    } catch (err) {
      // Une conso individuelle qui 404 (purgée entre les deux calls) ne doit
      // pas faire échouer le sync de la ligne — on saute.
      if (err instanceof VoipApiError && err.status === 404) continue;
      throw err;
    }
    const normalized = normalizeOvhConsumption(detail);
    if (!normalized) continue;
    if (normalized.startedAt < since || normalized.startedAt > until) continue;
    calls.push(normalized);
  }
  return calls;
}

/**
 * Pull les call logs OVH de TOUTES les lignes du compte, sur la fenêtre
 * `[since ; until]`.
 *
 * Découvre les billingAccounts puis les serviceNames, puis pull les
 * voiceConsumption de chaque ligne. Filtre côté client sur
 * `creationDatetime` (l'API voiceConsumption ne filtre pas par date).
 */
export async function fetchOvhCdr(
  creds: OvhCreds,
  opts: FetchCdrOptions,
): Promise<NormalizedCall[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = hostFor(creds);
  const until = opts.until ?? new Date();

  // Signer auto-re-synchronisé : un seul /auth/time initial, re-fetché ensuite
  // toutes les ~20s d'horloge écoulée (cf OvhSigner) pour éviter les 401
  // QUERY_TIME_OUT sur un gros pull multi-lignes.
  const signer = await OvhSigner.create(host, fetchImpl);

  // 1. billingAccounts du compte.
  const billingAccounts = await signer.get<string[]>(
    host,
    '/telephony',
    creds,
    fetchImpl,
  );
  if (!Array.isArray(billingAccounts)) {
    throw new VoipApiError('ovh_unexpected_billing_list', 502, 'ovh');
  }

  const calls: NormalizedCall[] = [];
  let lineCount = 0;
  for (const ba of billingAccounts) {
    // 2. serviceNames (lignes) du billingAccount.
    const services = await signer.get<string[]>(
      host,
      `/telephony/${encodeURIComponent(ba)}/service`,
      creds,
      fetchImpl,
    );
    if (!Array.isArray(services)) continue;
    for (const sn of services) {
      if (lineCount >= MAX_LINES) return calls;
      lineCount++;
      const lineCalls = await fetchLineCdr(
        host,
        ba,
        sn,
        creds,
        signer,
        opts.since,
        until,
        fetchImpl,
      );
      calls.push(...lineCalls);
    }
  }
  return calls;
}
