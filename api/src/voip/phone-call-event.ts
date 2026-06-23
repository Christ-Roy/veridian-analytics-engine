/**
 * Construction de l'event staminads `phone_call` depuis un `NormalizedCall`.
 *
 * Reflète RIGOUREUSEMENT le contrat émis historiquement par
 * `veridian-bridge/src/voip/sync.ts:pushStaminadsEvents` ET prouvé par le
 * fixture démo (`demo/fixtures/voip-calls.ts`) : un appel = un goal event
 * `name='goal'` / `goal_name='phone_call'` / `goal_value=durationSec`, poussé
 * dans `staminads_ws_<ws>.events`. Il apparaît alors automatiquement dans
 * Live / Explore / Goals natifs, filtrable par dimension `properties.source`.
 *
 * En natif (option A), on n'envoie PLUS ça par HTTP vers `/api/track` : on
 * construit le `TrackingEvent` ici et on l'insère via `EventBufferService`
 * (appel interne). Le `dedup_token` déterministe garantit l'idempotence (un
 * re-sync du même appel écrase, ne duplique pas).
 */

import { TrackingEvent } from '../events/entities/event.entity';
import { toClickHouseDateTime } from '../common/utils/datetime.util';
import { NormalizedCall, PhoneSource } from './voip.types';

export interface SourceMatch {
  source: PhoneSource;
  id: string;
  label: string;
}

/**
 * Transforme un appel normalisé en `TrackingEvent` goal `phone_call`.
 *
 * @param workspaceId  workspace cible
 * @param provider     'ovh' | 'telnyx' (porté dans referrer + properties)
 * @param call         appel normalisé issu du provider
 * @param match        source attribuée (lookup e164→source) ou null → `direct`
 */
export function buildPhoneCallEvent(
  workspaceId: string,
  provider: 'ovh' | 'telnyx',
  call: NormalizedCall,
  match: SourceMatch | null,
): TrackingEvent {
  const chDate = toClickHouseDateTime(call.startedAt);
  const callTs = call.startedAt.getTime();
  const sessionId = `voip:${provider}:${call.externalId}`;
  const source: PhoneSource = match?.source ?? 'direct';

  const properties: Record<string, string> = {
    direction: call.direction,
    duration_sec: String(call.durationSec),
    status: call.status,
    from_number: call.fromNumber,
    to_number: call.toNumber,
    provider,
    external_id: call.externalId,
    source,
    // Visibilité de l'attribution : un numéro non mappé à une source (vision
    // "1 numéro = 1 source") retombe sur `direct` POUR L'AFFICHAGE, mais on
    // marque explicitement que l'attribution n'a PAS eu lieu. Permet de
    // filtrer/alerter sur les numéros à configurer côté Settings → VoIP sans
    // casser l'affichage natif (Live/Explore/Goals). Sinon ces appels
    // polluent `direct` en silence (le client ne sait pas qu'il lui manque un
    // numéro). Cf ticket 2026-06-23-voip-attribution-borgne.
    source_attributed: match ? 'true' : 'false',
  };
  if (match) {
    properties.tracked_number_id = match.id;
    if (match.label) properties.tracked_number_label = match.label;
  }
  if (call.recordingUrl) properties.recording_url = call.recordingUrl;

  return {
    session_id: sessionId,
    workspace_id: workspaceId,
    received_at: chDate,
    created_at: chDate,
    updated_at: chDate,
    name: 'goal',
    path: '/voip',
    duration: 0,
    page_duration: 0,
    previous_path: '',
    referrer: `voip://${provider}`,
    referrer_domain: '',
    referrer_path: '',
    is_direct: false,
    landing_page: '/voip',
    landing_domain: '',
    landing_path: '/voip',
    utm_source: '',
    utm_medium: '',
    utm_campaign: '',
    utm_term: '',
    utm_content: '',
    utm_id: '',
    utm_id_from: '',
    channel: '',
    channel_group: '',
    stm_1: '',
    stm_2: '',
    stm_3: '',
    stm_4: '',
    stm_5: '',
    stm_6: '',
    stm_7: '',
    stm_8: '',
    stm_9: '',
    stm_10: '',
    screen_width: 0,
    screen_height: 0,
    viewport_width: 0,
    viewport_height: 0,
    device: '',
    browser: '',
    browser_type: '',
    os: '',
    user_agent: '',
    connection_type: '',
    language: 'fr-FR',
    timezone: 'Europe/Paris',
    country: 'FR',
    region: '',
    city: '',
    latitude: null,
    longitude: null,
    max_scroll: 0,
    sdk_version: 'voip-sync-1.0',
    page_number: 1,
    dedup_token: `${sessionId}_goal_phone_call_${callTs}`,
    _version: callTs,
    goal_name: 'phone_call',
    goal_value: call.durationSec,
    entered_at: chDate,
    exited_at: chDate,
    goal_timestamp: chDate,
    user_id: null,
    // B2B identification: a phone call has no web visitor_id/fingerprint, and
    // the IP is not a web client IP — leave empty (schema columns default '').
    visitor_id: '',
    fingerprint: '',
    ip: '',
    properties,
  };
}
