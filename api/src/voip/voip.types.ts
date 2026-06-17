/**
 * Types partagés du module VoIP natif (port de `veridian-bridge/src/voip/`).
 *
 * Chaque provider (OVH, Telnyx) a son format CDR natif. Les clients
 * `providers/*.ts` les normalisent vers `NormalizedCall` : le sync ne connaît
 * QUE cette shape, et l'event `phone_call` poussé en interne la reflète.
 *
 * VISION (Robert 2026-05-23/05-25) : les appels VoIP ne vivent PAS dans une
 * page custom. Ce sont des events staminads `phone_call` natifs poussés en
 * interne via `EventBufferService`, donc visibles automatiquement dans
 * Live / Explore / Goals, filtrables par dimension `source` (1 numéro = 1
 * source). Le module VoIP ne stocke PLUS les appels (pas de table SipCall) :
 * ClickHouse `events` est l'unique source de vérité.
 */

/** Provider VoIP supporté. */
export type VoipProvider = 'ovh' | 'telnyx';

/** kind d'un credential VoIP stocké en DB. */
export type VoipCredentialKind = 'voip_ovh' | 'voip_telnyx';

/** Statut d'un credential VoIP, tenu par le service creds. */
export type VoipCredentialStatus = 'untested' | 'ok' | 'failed';

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus = 'answered' | 'missed' | 'busy' | 'failed';

/**
 * Un appel normalisé, indépendant du provider. C'est ce que `fetchCdr()`
 * retourne et ce que le sync pousse comme event `phone_call`.
 */
export interface NormalizedCall {
  /** id stable de l'appel chez le provider (clé d'idempotence). */
  externalId: string;
  direction: CallDirection;
  /** numéro appelant, format E.164 si possible (ex `+33612345678`). */
  fromNumber: string;
  /** numéro appelé, format E.164 si possible. */
  toNumber: string;
  durationSec: number;
  status: CallStatus;
  /** URL de l'enregistrement audio, si dispo et activé. */
  recordingUrl: string | null;
  /** instant de début de l'appel. */
  startedAt: Date;
}

/** Erreur d'API provider VoIP. Porte le status HTTP pour le mapping. */
export class VoipApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly provider: VoipProvider,
  ) {
    super(message);
    this.name = 'VoipApiError';
  }
}

/** Options communes de `fetchCdr` côté providers. */
export interface FetchCdrOptions {
  /** borne basse (incluse) — appels démarrés après cette date. */
  since: Date;
  /** borne haute (incluse) — défaut `now`. */
  until?: Date;
  /** injection de fetch pour les tests. */
  fetchImpl?: typeof fetch;
}

// ─── Dimension `source` (vision 2026-05-25 : 1 numéro = 1 source) ──────────

/** Valeurs autorisées pour la dimension `source` des events `phone_call`. */
export const PHONE_NUMBER_SOURCES = [
  'seo',
  'ads',
  'direct',
  'email',
  'social',
  'print',
  'other',
] as const;

export type PhoneSource = (typeof PHONE_NUMBER_SOURCES)[number];

export function isPhoneSource(v: unknown): v is PhoneSource {
  return (
    typeof v === 'string' &&
    (PHONE_NUMBER_SOURCES as readonly string[]).includes(v)
  );
}

/** Un numéro tracké (mapping numéro → source). */
export interface TrackedPhoneNumber {
  id: string;
  workspace_id: string;
  e164: string;
  source: PhoneSource;
  label: string | null;
  created_at: string;
  updated_at: string;
}
