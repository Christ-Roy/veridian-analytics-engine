/**
 * Types partagés de la feature VoIP — CDR normalisés.
 *
 * Chaque provider (OVH, Telnyx) a son format CDR natif. Les clients
 * `providers/*.ts` les normalisent vers `NormalizedCall` : le sync ne connaît
 * QUE cette shape, et la table `SipCall` la reflète 1:1.
 */

export type CallDirection = "inbound" | "outbound";
export type CallStatus = "answered" | "missed" | "busy" | "failed";

/**
 * Un appel normalisé, indépendant du provider. C'est ce que `fetchCdr()`
 * retourne et ce que `syncCallLogs` upsert dans `SipCall`.
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
    public readonly provider: "ovh" | "telnyx",
  ) {
    super(message);
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
