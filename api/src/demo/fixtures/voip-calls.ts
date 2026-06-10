/**
 * VoIP fake calls generator for the public demo instance.
 *
 * Robert (vision 2026-05-25) : la démo doit montrer la feature VoIP en
 * action — sans bridge ni Postgres, puisque `compose/demo.yml` ne ship que
 * ClickHouse + engine. La feature Calls / VoIP côté commercial pousse en
 * prod des événements staminads `phone_call` (cf `veridian-bridge/src/voip/sync.ts`)
 * via `POST /api/track`. La démo n'a pas de bridge — on insère donc les
 * mêmes events directement dans ClickHouse via `insertWorkspace`, en
 * respectant rigoureusement le contrat émis par `voip/sync.ts:pushStaminadsEvents`
 * pour que Live / Explore / Goals natifs staminads les reconnaissent.
 *
 * Le shape `TrackingEvent` est goal-strict (cf event.entity.ts) :
 *   - `name = 'goal'` + `goal_name = 'phone_call'` + `goal_value = duration_sec`
 *   - `properties.source` = `seo` | `ads` | `direct` (dimension demandée)
 *   - `properties.to_number`, `from_number`, `direction`, `status`,
 *     `duration_sec`, `provider`, `external_id`, `tracked_number_id`
 *   - `session_id = "voip:<provider>:<externalId>"` (pseudo-session VoIP,
 *     pas de pageview associée — c'est intentionnel, l'appel n'a pas de
 *     contexte browser)
 *   - `dedup_token = "<session_id>_goal_phone_call_<ts>"` (idempotence
 *     re-seed via le pipeline staminads natif)
 *
 * Idempotence : les `externalId` sont déterministes (offset 0..N), donc
 * re-générer écrase les anciens events grâce au `dedup_token` natif staminads.
 *
 * Gating : appelée UNIQUEMENT depuis `DemoService.generate()`, qui est lui-même
 * gated par `DEMO_SECRET` (DemoProtected guard) et configuré seulement quand
 * `IS_DEMO=true` (cf `compose/demo.yml`). Pas de seed VoIP en prod réelle.
 */

import { TrackingEvent } from '../../events/entities/event.entity';
import { toClickHouseDateTime } from '../../common/utils/datetime.util';

/** Source de trafic = vision 2026-05-25 (1 numéro = 1 source). */
export type DemoPhoneSource = 'seo' | 'ads' | 'direct';

/** Provider VoIP factice (cf `veridian-bridge/src/credentials/providers.ts`). */
export type DemoVoipProvider = 'ovh' | 'telnyx';

/**
 * Numéros démo trackés — calqués sur ce que le bridge auraient en prod
 * (table `TenantPhoneNumber`). Ces numéros ne sortent JAMAIS de la démo :
 * ils figurent dans `properties.to_number` des events `phone_call`.
 */
export interface DemoTrackedNumber {
  /** id stable pour la dimension `tracked_number_id`. */
  id: string;
  /** numéro E.164 — affiché tel quel dans Live/Explore. */
  e164: string;
  /** source attribuée à ce numéro. */
  source: DemoPhoneSource;
  /** libellé human-readable (non utilisé côté event, juste pour clarté). */
  label: string;
  /** poids de distribution dans le pool d'appels générés. */
  weight: number;
}

export const DEMO_TRACKED_NUMBERS: DemoTrackedNumber[] = [
  {
    id: 'demo-phone-seo',
    e164: '+33177123456',
    source: 'seo',
    label: 'Ligne fixe site web',
    weight: 50,
  },
  {
    id: 'demo-phone-ads',
    e164: '+33180654321',
    source: 'ads',
    label: 'Numero Google Ads',
    weight: 35,
  },
  {
    id: 'demo-phone-direct',
    e164: '+33188999000',
    source: 'direct',
    label: 'Standard',
    weight: 15,
  },
];

/** Statuts d'appel pondérés (réaliste : majorité answered). */
const STATUS_WEIGHTS: Array<{ status: string; weight: number }> = [
  { status: 'answered', weight: 70 },
  { status: 'missed', weight: 20 },
  { status: 'busy', weight: 5 },
  { status: 'failed', weight: 5 },
];

/** Providers VoIP pondérés (mix réaliste OVH / Telnyx). */
const PROVIDER_WEIGHTS: Array<{ provider: DemoVoipProvider; weight: number }> = [
  { provider: 'ovh', weight: 70 },
  { provider: 'telnyx', weight: 30 },
];

/** Durées d'appel typiques (secondes) — distribution réaliste. */
const DURATION_BUCKETS: Array<{ min: number; max: number; weight: number }> = [
  { min: 10, max: 30, weight: 20 }, // raté ou bref
  { min: 30, max: 120, weight: 35 }, // standard
  { min: 120, max: 300, weight: 30 }, // engagé (5 min)
  { min: 300, max: 480, weight: 15 }, // long (8 min)
];

function weightedPick<T extends { weight: number }>(items: T[]): T {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Heure ouvrée plausible (9h-18h, pondéré). */
function pickBusinessHour(): number {
  // 9h-12h et 14h-18h pondérés plus haut que la pause déjeuner
  const hours = [
    { h: 9, w: 8 },
    { h: 10, w: 12 },
    { h: 11, w: 14 },
    { h: 12, w: 6 }, // pause déj
    { h: 13, w: 4 },
    { h: 14, w: 12 },
    { h: 15, w: 14 },
    { h: 16, w: 12 },
    { h: 17, w: 10 },
    { h: 18, w: 8 },
  ];
  const total = hours.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const it of hours) {
    r -= it.w;
    if (r <= 0) return it.h;
  }
  return 14;
}

/** Numéro appelant aléatoire — format FR (+33 6xx xx xx xx). */
function randomFrenchCallerNumber(seed: number): string {
  // Pseudo-stable : on dérive du seed pour avoir un peu de répétition (les
  // mêmes prospects rappellent), mais on garde du bruit.
  const block1 = ((seed * 17) % 90) + 10; // 10-99
  const block2 = ((seed * 31) % 90) + 10;
  const block3 = ((seed * 53) % 90) + 10;
  const block4 = ((seed * 71) % 90) + 10;
  return `+336${block1}${block2}${block3}${block4}`;
}

/** Config de génération. */
export interface VoipCallsConfig {
  workspaceId: string;
  /** Fin de la fenêtre (= maintenant). */
  endDate: Date;
  /** Profondeur de la fenêtre (jours). Défaut : 30. */
  daysRange?: number;
  /** Nombre total d'appels à générer. Défaut : 30. */
  callCount?: number;
}

/**
 * Génère des événements `phone_call` (goals staminads) répartis sur la
 * fenêtre temporelle. Retourne directement des `TrackingEvent` insérables
 * via `ClickHouseService.insertWorkspace(workspaceId, 'events', batch)`.
 *
 * Couvre :
 *   - Lundi-vendredi uniquement (heures ouvrées 9h-18h)
 *   - Répartition selon `weight` des numéros trackés (50/35/15 par défaut)
 *   - Status pondéré (70% answered, 20% missed, etc.)
 *   - Provider mix OVH/Telnyx
 *   - Durées réalistes (10s à 8min)
 */
export function generateVoipCalls(config: VoipCallsConfig): TrackingEvent[] {
  const daysRange = config.daysRange ?? 30;
  const callCount = config.callCount ?? 30;
  const events: TrackingEvent[] = [];

  for (let i = 0; i < callCount; i++) {
    // Distribute over the past `daysRange` days, business days only
    let attempt = 0;
    let callDate: Date;
    do {
      const daysAgo = Math.floor(Math.random() * daysRange);
      callDate = new Date(config.endDate);
      callDate.setDate(callDate.getDate() - daysAgo);
      attempt++;
    } while (
      (callDate.getDay() === 0 || callDate.getDay() === 6) &&
      attempt < 10
    );

    callDate.setHours(pickBusinessHour(), randomBetween(0, 59), randomBetween(0, 59), 0);

    // Clamp to `endDate` ("now") : when daysAgo === 0 the business hour drawn
    // above (9h-18h) can land after endDate's own time-of-day, producing a
    // call "in the future". An appel ne peut pas être passé après maintenant —
    // on ramène à endDate. Évite le flaky de borne haute (cf
    // todo/2026-06-02-flaky-voip-calls-spec-line-86.md).
    if (callDate.getTime() > config.endDate.getTime()) {
      callDate = new Date(config.endDate);
    }

    const tracked = weightedPick(DEMO_TRACKED_NUMBERS);
    const provider = weightedPick(PROVIDER_WEIGHTS).provider;
    const status = weightedPick(STATUS_WEIGHTS).status;
    const durationBucket = weightedPick(DURATION_BUCKETS);
    const durationSec =
      status === 'answered'
        ? randomBetween(durationBucket.min, durationBucket.max)
        : randomBetween(5, 25); // missed/busy/failed = bref

    const externalId = `demo-call-${i.toString().padStart(4, '0')}`;
    const sessionId = `voip:${provider}:${externalId}`;
    const fromNumber = randomFrenchCallerNumber(i);
    const callTs = callDate.getTime();
    const chDate = toClickHouseDateTime(callDate);

    const event: TrackingEvent = {
      session_id: sessionId,
      workspace_id: config.workspaceId,
      received_at: chDate,
      created_at: chDate,
      updated_at: chDate,
      name: 'goal',
      path: '/voip',
      duration: 0,
      page_duration: 0,
      previous_path: '',
      // Traffic source - aligné sur ce que sync.ts envoie (`referrer = voip://<provider>`)
      referrer: `voip://${provider}`,
      referrer_domain: '',
      referrer_path: '',
      is_direct: false,
      // Landing page = pseudo-route VoIP
      landing_page: '/voip',
      landing_domain: 'www.apple.com',
      landing_path: '/voip',
      // UTM vides — l'appel n'a pas de contexte campagne (porté par `source`)
      utm_source: '',
      utm_medium: '',
      utm_campaign: '',
      utm_term: '',
      utm_content: '',
      utm_id: '',
      utm_id_from: '',
      channel: '',
      channel_group: '',
      // Custom dims (laisser vide — la dimension `source` vit dans properties)
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
      // Pas de browser context (appel téléphonique = pas de viewport)
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
      sdk_version: 'voip-seed-1.0',
      // V3 fields — goal event
      page_number: 1,
      dedup_token: `${sessionId}_goal_phone_call_${callTs}`,
      _version: callTs,
      goal_name: 'phone_call',
      goal_value: durationSec,
      entered_at: chDate,
      exited_at: chDate,
      goal_timestamp: chDate,
      user_id: null,
      // Properties : dimension `source` + métadonnées appel (cf sync.ts)
      properties: {
        direction: 'inbound',
        duration_sec: String(durationSec),
        status,
        from_number: fromNumber,
        to_number: tracked.e164,
        provider,
        external_id: externalId,
        source: tracked.source,
        tracked_number_id: tracked.id,
        tracked_number_label: tracked.label,
      },
    };

    events.push(event);
  }

  // Trier par date pour avoir des inserts ordonnés (cosmétique, pas requis
  // par ClickHouse mais plus lisible côté logs).
  events.sort((a, b) => a.received_at.localeCompare(b.received_at));
  return events;
}
