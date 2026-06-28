/**
 * Demo-mode tenant data generator.
 *
 * Builds realistic-but-synthetic staminads events (web pageviews, scrolls,
 * goals, and VoIP `phone_call` goals) INSIDE an existing real workspace so a
 * prospect/client can SEE the product full of life before they have any real
 * traffic. Unlike the public `demo-apple` instance (`DemoService`), this does
 * NOT create a workspace or drop a database — it injects rows into the tenant's
 * own tables and they are removed surgically by `demoWipe`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NON-NEGOTIABLE INVARIANT: every row carries the `vrddemo_` session_id
 * prefix.
 *
 * The wipe filters on `startsWith(<session_id col>, 'vrddemo_')`, which is the
 * key present on all four tables (events.session_id, sessions.id,
 * pages.session_id, goals.session_id) AND part of each ORDER BY (cheap
 * mutation). We deliberately do NOT reuse:
 *   - `demo-`  → too close to a value a real tracker could emit.
 *   - `voip:`  → that is the prefix of REAL prod call logs
 *     (`voip:<provider>:<externalId>`, see voip/sync.ts). A wipe on `voip:`
 *     would destroy a client's real calls. Demo calls use `vrddemo_voip_…`.
 *
 * We ALSO tag every event with `properties['_demo'] = '1'` (web, goal AND
 * voip). The tag is a redundant, human-auditable marker; it is NOT what the
 * wipe keys on, because the materialized views do not propagate `properties`
 * onto the `sessions`/`pages` tables, and the events TTL (7d) would purge the
 * events before a deferred wipe — leaving orphan tagged-but-unfindable session
 * rows. The session_id prefix survives both.
 */

import { randomUUID } from 'crypto';
import { TrackingEvent } from '../../events/entities/event.entity';
import { toClickHouseDateTime } from '../../common/utils/datetime.util';

/** The one prefix the wipe keys on. Present on every generated session_id. */
export const DEMO_SESSION_PREFIX = 'vrddemo_';

/** Redundant per-event audit tag (properties['_demo'] = '1'). */
export const DEMO_PROPERTY_KEY = '_demo';
export const DEMO_PROPERTY_VALUE = '1';

export interface DemoGenConfig {
  workspaceId: string;
  /** Tenant website (drives landing_page / referrer realism). */
  website: string;
  /** End of the window (defaults to now). */
  endDate: Date;
  /** Window depth in days. */
  daysRange: number;
  /** Number of web sessions to synthesize. */
  sessionCount: number;
  /** Number of VoIP `phone_call` goals to synthesize. */
  voipCount: number;
  /**
   * Unique run id woven into every session_id so concurrent/stacked seeds never
   * collide on dedup_token. The global `vrddemo_` prefix still wipes them all.
   */
  runId: string;
}

export interface DemoGenResult {
  events: TrackingEvent[];
  sessionCount: number;
  voipCount: number;
}

// ─── weighted-pick helpers ────────────────────────────────────────────────
interface Weighted {
  weight: number;
}
function weightedPick<T extends Weighted>(items: T[]): T {
  const total = items.reduce((s, it) => s + it.weight, 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= it.weight;
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── realistic, generic fixtures (NOT Apple-specific) ─────────────────────
const PAGES: Array<{ path: string; weight: number }> = [
  { path: '/', weight: 40 },
  { path: '/services', weight: 18 },
  { path: '/tarifs', weight: 12 },
  { path: '/a-propos', weight: 8 },
  { path: '/blog', weight: 10 },
  { path: '/contact', weight: 12 },
];

interface Channel {
  referrerDomain: string | null;
  referrerPath: string;
  channel: string;
  channelGroup: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  isDirect: boolean;
  weight: number;
}
const CHANNELS: Channel[] = [
  {
    referrerDomain: 'google.com',
    referrerPath: '/search',
    channel: 'organic_search',
    channelGroup: 'Organic Search',
    utmSource: '',
    utmMedium: '',
    utmCampaign: '',
    isDirect: false,
    weight: 38,
  },
  {
    referrerDomain: null,
    referrerPath: '',
    channel: 'direct',
    channelGroup: 'Direct',
    utmSource: '',
    utmMedium: '',
    utmCampaign: '',
    isDirect: true,
    weight: 25,
  },
  {
    referrerDomain: 'google.com',
    referrerPath: '/search',
    channel: 'paid_search',
    channelGroup: 'Paid Search',
    utmSource: 'google',
    utmMedium: 'cpc',
    utmCampaign: 'brand_fr',
    isDirect: false,
    weight: 16,
  },
  {
    referrerDomain: 'facebook.com',
    referrerPath: '/',
    channel: 'paid_social',
    channelGroup: 'Paid Social',
    utmSource: 'facebook',
    utmMedium: 'paid_social',
    utmCampaign: 'retargeting',
    isDirect: false,
    weight: 11,
  },
  {
    referrerDomain: 'linkedin.com',
    referrerPath: '/feed',
    channel: 'social',
    channelGroup: 'Social',
    utmSource: '',
    utmMedium: '',
    utmCampaign: '',
    isDirect: false,
    weight: 10,
  },
];

interface Device {
  device: string;
  browser: string;
  browserType: string;
  os: string;
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  weight: number;
}
const DEVICES: Device[] = [
  {
    device: 'desktop',
    browser: 'Chrome',
    browserType: 'desktop',
    os: 'Windows',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124',
    screenWidth: 1920,
    screenHeight: 1080,
    weight: 40,
  },
  {
    device: 'mobile',
    browser: 'Safari',
    browserType: 'mobile',
    os: 'iOS',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4) Safari/605',
    screenWidth: 390,
    screenHeight: 844,
    weight: 38,
  },
  {
    device: 'mobile',
    browser: 'Chrome',
    browserType: 'mobile',
    os: 'Android',
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/124 Mobile',
    screenWidth: 412,
    screenHeight: 915,
    weight: 14,
  },
  {
    device: 'desktop',
    browser: 'Safari',
    browserType: 'desktop',
    os: 'macOS',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) Safari/605',
    screenWidth: 1680,
    screenHeight: 1050,
    weight: 8,
  },
];

interface GeoProfile {
  country: string;
  region: string;
  city: string;
  language: string;
  timezone: string;
  weight: number;
}
const GEOS: GeoProfile[] = [
  { country: 'FR', region: 'Île-de-France', city: 'Paris', language: 'fr-FR', timezone: 'Europe/Paris', weight: 50 },
  { country: 'FR', region: 'Auvergne-Rhône-Alpes', city: 'Lyon', language: 'fr-FR', timezone: 'Europe/Paris', weight: 20 },
  { country: 'FR', region: "Provence-Alpes-Côte d'Azur", city: 'Marseille', language: 'fr-FR', timezone: 'Europe/Paris', weight: 15 },
  { country: 'BE', region: 'Brussels', city: 'Bruxelles', language: 'fr-BE', timezone: 'Europe/Brussels', weight: 8 },
  { country: 'CH', region: 'Geneva', city: 'Genève', language: 'fr-CH', timezone: 'Europe/Zurich', weight: 7 },
];

// Web goals the demo fires (native staminads goal events).
const WEB_GOALS = ['form_submission', 'newsletter_signup', 'purchase'] as const;

/** Hostname extracted from the tenant website (fallback safe). */
function hostFromWebsite(website: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return url.hostname.toLowerCase() || 'demo.veridian.site';
  } catch {
    return 'demo.veridian.site';
  }
}

/** A returning-visitor pool so unique_visitors < sessions (feature #1 showcase). */
function makeVisitorAllocator() {
  const pool: string[] = [];
  return (i: number): string => {
    if (pool.length > 0 && Math.random() < 0.3) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    const id = `vrddemo-visitor-${i.toString().padStart(6, '0')}-${randomUUID().slice(0, 8)}`;
    pool.push(id);
    return id;
  };
}

/**
 * Generate the full set of demo events for ONE seed run. All events share the
 * `vrddemo_<runId>_…` session_id prefix and the `_demo=1` property tag.
 */
export function generateDemoEvents(config: DemoGenConfig): DemoGenResult {
  const host = hostFromWebsite(config.website);
  const events: TrackingEvent[] = [];
  const allocVisitor = makeVisitorAllocator();

  const windowMs = config.daysRange * 24 * 60 * 60 * 1000;
  const startMs = config.endDate.getTime() - windowMs;

  // ── Web sessions ──────────────────────────────────────────────────────
  for (let i = 0; i < config.sessionCount; i++) {
    const sessionId = `${DEMO_SESSION_PREFIX}${config.runId}_s${i.toString().padStart(6, '0')}`;
    const channel = weightedPick(CHANNELS);
    const device = weightedPick(DEVICES);
    const geo = weightedPick(GEOS);
    const landing = weightedPick(PAGES);

    // Business-hours-leaning timestamp inside the window.
    const sessionStart = new Date(startMs + Math.random() * windowMs);
    sessionStart.setHours(randInt(8, 21), randInt(0, 59), randInt(0, 59), 0);
    if (sessionStart.getTime() > config.endDate.getTime()) {
      sessionStart.setTime(config.endDate.getTime() - randInt(60_000, 3_600_000));
    }

    const durationSec = weightedPick([
      { v: randInt(3, 12), weight: 30 }, // bounce
      { v: randInt(20, 90), weight: 40 }, // engaged
      { v: randInt(90, 300), weight: 22 }, // deep
      { v: randInt(300, 900), weight: 8 }, // power
    ]).v;

    const visitorId = allocVisitor(i);
    const fingerprint = `vrddemo_${device.device}_${device.os}`;
    const ip = `203.0.113.${(i % 254) + 1}`; // TEST-NET-3 (RFC 5737)
    const referrer = channel.referrerDomain
      ? `https://www.${channel.referrerDomain}${channel.referrerPath}`
      : '';
    const landingPage = `https://${host}${landing.path}`;

    const base = makeBaseProps({
      sessionId,
      workspaceId: config.workspaceId,
      host,
      landing: landing.path,
      landingPage,
      channel,
      device,
      geo,
      referrer,
      visitorId,
      fingerprint,
      ip,
    });

    const startCh = toClickHouseDateTime(sessionStart);
    const version = sessionStart.getTime();

    // pageview (landing)
    events.push({
      ...base,
      received_at: startCh,
      created_at: startCh,
      updated_at: startCh,
      name: 'screen_view',
      path: landing.path,
      duration: 0,
      page_duration: 0,
      previous_path: '',
      max_scroll: 0,
      page_number: 1,
      dedup_token: `${sessionId}_pv_1`,
      _version: version,
      goal_name: '',
      goal_value: 0,
      entered_at: startCh,
      exited_at: startCh,
      goal_timestamp: null,
    });

    // optional second pageview
    let pageCount = 1;
    if (Math.random() < 0.45 && durationSec > 25) {
      pageCount = 2;
      const second = weightedPick(PAGES);
      const t = new Date(sessionStart.getTime() + durationSec * 500);
      const tCh = toClickHouseDateTime(t);
      events.push({
        ...base,
        received_at: tCh,
        created_at: startCh,
        updated_at: tCh,
        name: 'screen_view',
        path: second.path,
        duration: Math.round(durationSec * 0.5) * 1000,
        page_duration: Math.round(durationSec * 0.5) * 1000,
        previous_path: landing.path,
        max_scroll: randInt(30, 70),
        page_number: 2,
        dedup_token: `${sessionId}_pv_2`,
        _version: version,
        goal_name: '',
        goal_value: 0,
        entered_at: tCh,
        exited_at: tCh,
        goal_timestamp: null,
      });
    }

    // closing scroll → gives the session a real duration
    if (durationSec >= 5) {
      const end = new Date(sessionStart.getTime() + durationSec * 1000);
      const endClamped = end.getTime() > config.endDate.getTime() ? config.endDate : end;
      const endCh = toClickHouseDateTime(endClamped);
      events.push({
        ...base,
        received_at: endCh,
        created_at: startCh,
        updated_at: endCh,
        name: 'scroll',
        path: events[events.length - 1].path,
        duration: durationSec * 1000,
        page_duration: 0,
        previous_path: '',
        max_scroll: randInt(40, 100),
        page_number: pageCount,
        dedup_token: `${sessionId}_scroll_final`,
        _version: version,
        goal_name: '',
        goal_value: 0,
        entered_at: endCh,
        exited_at: endCh,
        goal_timestamp: null,
      });
    }

    // ~6% of engaged sessions convert a web goal
    if (durationSec > 30 && Math.random() < 0.06) {
      const goalName = weightedPick([
        { v: 'form_submission' as const, weight: 50 },
        { v: 'newsletter_signup' as const, weight: 35 },
        { v: 'purchase' as const, weight: 15 },
      ]).v;
      const goalTime = new Date(
        sessionStart.getTime() + durationSec * 1000 * (0.5 + Math.random() * 0.3),
      );
      const goalClamped =
        goalTime.getTime() > config.endDate.getTime() ? config.endDate : goalTime;
      const goalCh = toClickHouseDateTime(goalClamped);
      const goalValue = goalName === 'purchase' ? randInt(29, 480) : 0;
      events.push({
        ...base,
        received_at: goalCh,
        created_at: startCh,
        updated_at: goalCh,
        name: 'goal',
        path: landing.path,
        duration: 0,
        page_duration: 0,
        previous_path: '',
        max_scroll: 0,
        page_number: pageCount,
        dedup_token: `${sessionId}_goal_${goalName}_${goalClamped.getTime()}`,
        _version: version,
        goal_name: goalName,
        goal_value: goalValue,
        entered_at: goalCh,
        exited_at: goalCh,
        goal_timestamp: goalCh,
        properties: {
          [DEMO_PROPERTY_KEY]: DEMO_PROPERTY_VALUE,
        },
      });
    }
  }

  // ── VoIP phone_call goals (feature #2 showcase) ───────────────────────
  events.push(...generateDemoVoip(config, host));

  return {
    events,
    sessionCount: config.sessionCount,
    voipCount: config.voipCount,
  };
}

interface BasePropsInput {
  sessionId: string;
  workspaceId: string;
  host: string;
  landing: string;
  landingPage: string;
  channel: Channel;
  device: Device;
  geo: GeoProfile;
  referrer: string;
  visitorId: string;
  fingerprint: string;
  ip: string;
}

/**
 * Shared event fields for a web session. Always stamps `properties['_demo']`.
 */
function makeBaseProps(
  i: BasePropsInput,
): Omit<
  TrackingEvent,
  | 'received_at'
  | 'created_at'
  | 'updated_at'
  | 'name'
  | 'path'
  | 'duration'
  | 'page_duration'
  | 'previous_path'
  | 'max_scroll'
  | 'entered_at'
  | 'exited_at'
  | 'goal_timestamp'
  | 'page_number'
  | 'dedup_token'
  | '_version'
  | 'goal_name'
  | 'goal_value'
> {
  return {
    session_id: i.sessionId,
    workspace_id: i.workspaceId,
    referrer: i.referrer,
    referrer_domain: i.channel.referrerDomain ?? '',
    referrer_path: i.channel.referrerDomain ? i.channel.referrerPath : '',
    is_direct: i.channel.isDirect,
    landing_page: i.landingPage,
    landing_domain: i.host,
    landing_path: i.landing,
    utm_source: i.channel.utmSource,
    utm_medium: i.channel.utmMedium,
    utm_campaign: i.channel.utmCampaign,
    utm_term: '',
    utm_content: '',
    utm_id: '',
    utm_id_from: '',
    channel: i.channel.channel,
    channel_group: i.channel.channelGroup,
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
    screen_width: i.device.screenWidth,
    screen_height: i.device.screenHeight,
    viewport_width: Math.round(i.device.screenWidth * 0.95),
    viewport_height: Math.round(i.device.screenHeight * 0.88),
    device: i.device.device,
    browser: i.device.browser,
    browser_type: i.device.browserType,
    os: i.device.os,
    user_agent: i.device.userAgent,
    connection_type: '4g',
    language: i.geo.language,
    timezone: i.geo.timezone,
    country: i.geo.country,
    region: i.geo.region,
    city: i.geo.city,
    latitude: null,
    longitude: null,
    visitor_id: i.visitorId,
    fingerprint: i.fingerprint,
    ip: i.ip,
    sdk_version: 'vrddemo-seed-1.0',
    user_id: null,
    // Redundant audit tag on every web event.
    properties: { [DEMO_PROPERTY_KEY]: DEMO_PROPERTY_VALUE },
  };
}

/** Demo phone numbers mapped to traffic sources (1 number = 1 source). */
const DEMO_NUMBERS: Array<{ id: string; e164: string; source: string; label: string; weight: number }> = [
  { id: 'vrddemo-phone-seo', e164: '+33177000001', source: 'seo', label: 'Ligne site web', weight: 50 },
  { id: 'vrddemo-phone-ads', e164: '+33180000002', source: 'ads', label: 'Numéro Google Ads', weight: 35 },
  { id: 'vrddemo-phone-direct', e164: '+33188000003', source: 'direct', label: 'Standard', weight: 15 },
];
const CALL_STATUS = [
  { status: 'answered', weight: 70 },
  { status: 'missed', weight: 20 },
  { status: 'busy', weight: 5 },
  { status: 'failed', weight: 5 },
];
const PROVIDERS = [
  { provider: 'ovh', weight: 70 },
  { provider: 'telnyx', weight: 30 },
];

/**
 * VoIP `phone_call` goal events. session_id = `vrddemo_voip_<provider>_<ext>`
 * — NOT the real `voip:` prefix, so a demo wipe never touches real call logs.
 */
function generateDemoVoip(config: DemoGenConfig, host: string): TrackingEvent[] {
  const events: TrackingEvent[] = [];
  const windowMs = config.daysRange * 24 * 60 * 60 * 1000;
  const startMs = config.endDate.getTime() - windowMs;

  for (let i = 0; i < config.voipCount; i++) {
    const callDate = new Date(startMs + Math.random() * windowMs);
    // business hours, weekday-ish
    callDate.setHours(randInt(9, 18), randInt(0, 59), randInt(0, 59), 0);
    if (callDate.getTime() > config.endDate.getTime()) {
      callDate.setTime(config.endDate.getTime() - randInt(60_000, 3_600_000));
    }
    const tracked = weightedPick(DEMO_NUMBERS);
    const provider = weightedPick(PROVIDERS).provider;
    const status = weightedPick(CALL_STATUS).status;
    const durationSec =
      status === 'answered' ? randInt(20, 420) : randInt(5, 25);
    const externalId = `${config.runId}-${i.toString().padStart(4, '0')}`;
    const sessionId = `${DEMO_SESSION_PREFIX}voip_${provider}_${externalId}`;
    const ts = callDate.getTime();
    const ch = toClickHouseDateTime(callDate);
    const fromNumber = `+336${((i * 17) % 90) + 10}${((i * 31) % 90) + 10}${((i * 53) % 90) + 10}${((i * 71) % 90) + 10}`;

    events.push({
      session_id: sessionId,
      workspace_id: config.workspaceId,
      received_at: ch,
      created_at: ch,
      updated_at: ch,
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
      landing_domain: host,
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
      sdk_version: 'vrddemo-voip-1.0',
      page_number: 1,
      dedup_token: `${sessionId}_goal_phone_call_${ts}`,
      _version: ts,
      goal_name: 'phone_call',
      goal_value: durationSec,
      entered_at: ch,
      exited_at: ch,
      goal_timestamp: ch,
      visitor_id: '',
      fingerprint: '',
      ip: '',
      user_id: null,
      properties: {
        [DEMO_PROPERTY_KEY]: DEMO_PROPERTY_VALUE,
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
    });
  }
  return events;
}
