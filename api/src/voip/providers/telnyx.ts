/**
 * Client API Telnyx — pull des call logs (CDR) via la Detail Records API.
 *
 * Port direct de `veridian-bridge/src/voip/providers/telnyx.ts` (logique pure,
 * zéro dépendance bridge).
 *
 * Endpoint : GET /v2/detail_records?filter[record_type]=cdr
 *   - filtre `filter[started_at][gte]` / `[lte]` sur la fenêtre de sync
 *   - pagination `page[number]` / `page[size]`
 *   - auth : header `Authorization: Bearer <apiKey>`
 *
 * Les credentials Telnyx (`TelnyxCreds`) ne portent que `{ apiKey }`.
 *
 * Docs : https://developers.telnyx.com/api/detail-records.
 */

import type { TelnyxCreds } from '../voip.providers';
import {
  VoipApiError,
  type CallDirection,
  type CallStatus,
  type FetchCdrOptions,
  type NormalizedCall,
} from '../voip.types';

const TELNYX_BASE = 'https://api.telnyx.com/v2';
const PAGE_SIZE = 250;
const MAX_PAGES = 40;
/**
 * Timeout par requête HTTP vers Telnyx. Le `fetch` global Node n'a PAS de
 * timeout par défaut : sans cette borne, un provider qui laisse pendre la
 * connexion gèlerait le sync À VIE (flag `running` jamais relâché → arrêt
 * silencieux de TOUTE l'ingestion d'appels).
 */
const TELNYX_REQUEST_TIMEOUT_MS = 15000;

/** Forme brute d'un detail record CDR Telnyx (champs consommés). */
interface TelnyxCdr {
  id?: string;
  record_type?: string;
  /** "inbound" | "outbound" | "inbound-outbound". */
  direction?: string;
  from?: string;
  to?: string;
  /** durée en secondes (string ou number selon l'API). */
  duration?: number | string;
  /** "completed" | "failed" | "busy" | "no-answer" | "canceled" ... */
  status?: string;
  /** ISO date du début de l'appel. */
  started_at?: string;
  /** URL de l'enregistrement, si la fonction recording est activée. */
  recording_urls?: string[];
}

interface TelnyxListResponse {
  data?: TelnyxCdr[];
  meta?: { total_pages?: number; page_number?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Mappe la direction Telnyx → direction normalisée. */
function mapDirection(direction: string | undefined): CallDirection {
  return direction === 'outbound' ? 'outbound' : 'inbound';
}

/** Mappe le statut Telnyx → statut normalisé. */
function mapStatus(status: string | undefined): CallStatus {
  switch (status) {
    case 'completed':
    case 'answered':
      return 'answered';
    case 'busy':
      return 'busy';
    case 'no-answer':
    case 'no_answer':
    case 'canceled':
    case 'cancelled':
      return 'missed';
    default:
      return 'failed';
  }
}

/** Normalise un CDR Telnyx → NormalizedCall. */
export function normalizeTelnyxCdr(c: TelnyxCdr): NormalizedCall | null {
  if (!c.id) return null;
  const startedAt = c.started_at ? new Date(c.started_at) : new Date(0);
  const durationRaw =
    typeof c.duration === 'string' ? Number(c.duration) : (c.duration ?? 0);
  return {
    externalId: c.id,
    direction: mapDirection(c.direction),
    fromNumber: c.from ?? '',
    toNumber: c.to ?? '',
    durationSec: Math.max(
      0,
      Math.round(Number.isFinite(durationRaw) ? durationRaw : 0),
    ),
    status: mapStatus(c.status),
    recordingUrl:
      Array.isArray(c.recording_urls) && c.recording_urls.length > 0
        ? c.recording_urls[0]
        : null,
    startedAt,
  };
}

/** Un GET Telnyx avec backoff sur 429 / 5xx (max 3 tentatives). */
async function telnyxGet(
  url: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<TelnyxListResponse> {
  let attempt = 0;
  let lastErr: VoipApiError | null = null;
  while (attempt < 3) {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(TELNYX_REQUEST_TIMEOUT_MS),
    });
    if (res.ok) {
      return (await res.json()) as TelnyxListResponse;
    }
    if (res.status === 429 || res.status >= 500) {
      const txt = await res.text();
      lastErr = new VoipApiError(
        `telnyx_get_failed status=${res.status} body=${txt.slice(0, 200)}`,
        res.status,
        'telnyx',
      );
      await sleep(50 * Math.pow(2, attempt));
      attempt++;
      continue;
    }
    const txt = await res.text();
    throw new VoipApiError(
      `telnyx_get_failed status=${res.status} body=${txt.slice(0, 200)}`,
      res.status,
      'telnyx',
    );
  }
  throw lastErr ?? new VoipApiError('telnyx_get_failed', 500, 'telnyx');
}

/**
 * Pull les call logs Telnyx sur la fenêtre `[since ; until]`.
 *
 * Itère sur les pages tant que `meta.total_pages` n'est pas atteint
 * (plafonné à `MAX_PAGES`).
 */
export async function fetchTelnyxCdr(
  creds: TelnyxCreds,
  opts: FetchCdrOptions,
): Promise<NormalizedCall[]> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const until = opts.until ?? new Date();
  const calls: NormalizedCall[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = new URLSearchParams();
    params.set('filter[record_type]', 'cdr');
    params.set('filter[started_at][gte]', opts.since.toISOString());
    params.set('filter[started_at][lte]', until.toISOString());
    params.set('page[number]', String(page));
    params.set('page[size]', String(PAGE_SIZE));

    const body = await telnyxGet(
      `${TELNYX_BASE}/detail_records?${params.toString()}`,
      creds.apiKey,
      fetchImpl,
    );
    const records = body.data ?? [];
    for (const rec of records) {
      if (rec.record_type && rec.record_type !== 'cdr') continue;
      const normalized = normalizeTelnyxCdr(rec);
      if (normalized) calls.push(normalized);
    }
    const totalPages = body.meta?.total_pages ?? 1;
    if (records.length < PAGE_SIZE || page >= totalPages) break;
  }
  return calls;
}
