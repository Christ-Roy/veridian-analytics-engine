import { Injectable } from '@nestjs/common';
import type {
  WorkspaceCrmMapping,
  CrmGoalMapping,
} from '../../workspaces/entities/workspace.entity';

/**
 * TwentyEventMapper — maps a tracked analytics event onto a Twenty timeline
 * activity name + the identity used to resolve the target Person.
 *
 * GENERIC ENGINE (N4, 2026-06-23): the mapping is now driven by a per-workspace
 * `WorkspaceCrmMapping` config instead of hardcoded prospection Sets. Any
 * industry declares its own goal→milestone catalogue + identity resolution via
 * the M2M API; the prospection mapping survives ONLY as the built-in fallback
 * for workspaces that have no config (back-compat with the live site-audit
 * tunnel). It also carries the normalized acquisition source to the CRM (S4).
 *
 * Historic contract for the prospection fallback: CONTRATS-TUNNEL §4c.3
 * ("namespace.verbe", digests only) + §4a (the bridge alone maps raw goal names
 * → timeline names). Stateless, no I/O — safe to unit-test in isolation.
 *
 * Input shape = the `event.tracked` payload emitted by
 * `events/session-payload.handler.ts#emitTracked`:
 *   { workspace_id, event_type, event_id, payload: {
 *       path, goal_name, goal_value, properties, user_id, utm, referrer*, … } }
 */

/**
 * Timeline activity names.
 *
 * For the BUILT-IN prospection fallback these are the frozen §4c.3 names. With a
 * workspace `crm_mapping`, the name is whatever the workspace declared
 * (`CrmGoalMapping.timeline_name`) — hence the `string` widening. We keep the
 * literal union as documentation of the canonical prospection vocabulary.
 */
export type TwentyTimelineName =
  | 'audit.page_view'
  | 'audit.scroll'
  | 'audit.cta_click'
  | 'audit.rdv'
  | 'signup'
  | 'app.started'
  | 'score.threshold'
  | (string & {});

/**
 * Built-in prospection mapping (terrain site-audit 2026-06-10). Used ONLY when a
 * workspace has NO `crm_mapping.goals` declared. New industries override these by
 * declaring their own catalogue via the M2M API — no code change required.
 */
const CTA_GOALS = new Set([
  'audit_cta_rdv',
  'appointment_click',
  'roi_lead_click',
  'cta_click',
]);
const RDV_GOALS = new Set(['rdv_booked']);
const AUDIT_VIEW_GOALS = new Set(['audit_view', 'audit_page_view']);
const AUDIT_SCROLL_GOALS = new Set(['audit_scroll', 'scroll_depth']);
const SIGNUP_GOALS = new Set(['signup']);
const APP_STARTED_GOALS = new Set(['app_started']);

/**
 * Only these `properties.app` values earn an `app.started` milestone
 * (whitelist frozen §4a-bis). `roi-calculator` (site source) is EXCLUDED —
 * already covered by the hot-page (/roi) + CTA signals.
 */
const APP_STARTED_TIMELINE_APPS = new Set(['notifuse', 'prospection']);

/** Scroll depth (%) above which a /audit/ view counts as a `audit.scroll`. */
const AUDIT_SCROLL_THRESHOLD = 75;

/** Identity resolution strategy resolved for a single event. */
export type IdentityKind = 'email' | 'slug' | 'field';

export interface TrackedEventContext {
  workspace_id: string;
  event_type: string; // 'screen_view' | 'goal' | … (engine event.name)
  event_id: string;
  payload: Record<string, unknown>;
}

export interface MappedTimelineEvent {
  /**
   * NOTE: the deterministic Twenty activity id is NOT here — it depends on the
   * resolved targetPersonId (task #13), so the CONNECTOR computes it AFTER
   * Person resolution via deterministicTimelineId(personId, eventId, name).
   * The mapper only carries `eventId` + `name`, the inputs to that id.
   */
  /** Timeline activity `name` (frozen §4c.3 for the fallback, or workspace-declared). */
  name: TwentyTimelineName;
  /**
   * Identity used to resolve the Person §4c.1:
   *   - an email (contains '@') → emails.primaryEmail
   *   - a slug → auditSlug
   *   - a custom field value (UUID Supabase…) → identityField[eq] (N4)
   */
  identity: string;
  /** How `identity` must be resolved against Twenty (drives the filter form). */
  identityKind: IdentityKind;
  /** Twenty custom field to match when identityKind = 'field' (e.g. 'supabaseId'). */
  identityField?: string;
  /** True heure de l'event ISO UTC §4c.2 — jamais l'heure d'écriture. */
  happensAt: string;
  /** Stable id of the underlying tracked event — used for delivery dedup. */
  eventId: string;
  /** Extra timeline properties (audit trail §4.3 + S4 acquisition source). */
  properties: Record<string, unknown>;
}

@Injectable()
export class TwentyEventMapper {
  /**
   * Map a tracked event to ALL the timeline milestones it produces (0, 1 or 2).
   *
   * Most events produce NONE (raw stream noise, unknown goal, no identity).
   * A single event can produce TWO milestones: a deep /audit/ screen_view emits
   * BOTH `audit.page_view` AND `audit.scroll` (prospection fallback). The
   * connector derives each milestone's deterministic id from
   * (personId, eventId, name) after resolving the Person (task #13).
   *
   * @param config the workspace's CRM mapping. When it declares `goals`, those
   *               rules drive the mapping; otherwise the built-in prospection
   *               fallback applies.
   */
  mapAll(
    event: TrackedEventContext,
    config?: WorkspaceCrmMapping,
  ): MappedTimelineEvent[] {
    const p = event.payload ?? {};
    const { identity, identityKind, identityField } = this.resolveIdentity(
      p.user_id,
      config,
    );
    if (!identity) return []; // no identity → no Person to attach to

    const isPhoneCall =
      event.event_type === 'goal' &&
      String(p.goal_name ?? '') === 'phone_call';

    // A workspace MAY map phone_call explicitly in its goals catalogue. If it
    // didn't, S4 still emits a default phone_call milestone (calls matter to
    // every industry). We never emit it twice.
    const configMatchedPhoneCall =
      isPhoneCall &&
      !!config?.goals?.some((r) => r.match === 'goal:phone_call');

    const names = config?.goals?.length
      ? this.resolveNamesFromConfig(event.event_type, p, config.goals)
      : this.resolveNamesBuiltin(event.event_type, p);

    // S4 — phone_call → a CRM milestone for every industry (default on), unless
    // the workspace already mapped it explicitly above.
    if (
      isPhoneCall &&
      !configMatchedPhoneCall &&
      (config?.map_phone_calls ?? true)
    ) {
      names.push(config?.phone_call_timeline_name || 'appel');
    }

    if (names.length === 0) return [];

    const happensAt = this.resolveHappensAt(p);
    const properties = this.buildProperties(event, p);
    return names.map((name) => ({
      name,
      identity,
      identityKind,
      identityField,
      happensAt,
      eventId: event.event_id,
      properties,
    }));
  }

  /**
   * Single-milestone convenience wrapper (first milestone or null). Kept for
   * callers that only need one; the connector uses mapAll to not drop the
   * page_view of a deep audit view.
   */
  map(
    event: TrackedEventContext,
    config?: WorkspaceCrmMapping,
  ): MappedTimelineEvent | null {
    return this.mapAll(event, config)[0] ?? null;
  }

  // ─── Config-driven mapping (N4) ─────────────────────────────────────────

  /**
   * Resolve milestone names from the workspace's declared rules. A rule matches
   * either a goal (`goal:<name>`) or a screen_view path prefix
   * (`screen_view:<prefix>`), with an optional scroll threshold. Rules are
   * ordered; ALL matching rules fire (a deep view can yield page_view + scroll).
   */
  private resolveNamesFromConfig(
    eventType: string,
    p: Record<string, unknown>,
    rules: CrmGoalMapping[],
  ): TwentyTimelineName[] {
    const out: TwentyTimelineName[] = [];
    const goal = String(p.goal_name ?? '');
    const path = String(p.path ?? '');

    for (const rule of rules) {
      const [kind, ...rest] = rule.match.split(':');
      const target = rest.join(':');
      if (eventType === 'goal' && kind === 'goal' && goal === target) {
        if (!this.scrollOk(p, rule.min_scroll)) continue;
        out.push(rule.timeline_name);
      } else if (
        eventType === 'screen_view' &&
        kind === 'screen_view' &&
        (target === '' || path.startsWith(target))
      ) {
        if (!this.scrollOk(p, rule.min_scroll)) continue;
        out.push(rule.timeline_name);
      }
    }
    return out;
  }

  /** A rule with no `min_scroll` always passes; otherwise the page scroll must reach it. */
  private scrollOk(p: Record<string, unknown>, min?: number): boolean {
    if (min === undefined || min === null) return true;
    const scroll = this.coerceNumber(
      (p as { max_scroll?: unknown }).max_scroll ??
        p.scroll ??
        (p.properties as Record<string, unknown> | undefined)?.depth,
    );
    return scroll !== null && scroll >= min;
  }

  // ─── Built-in prospection fallback (back-compat) ────────────────────────

  /**
   * Resolve ALL timeline names a raw event produces with the BUILT-IN
   * prospection mapping. A deep /audit/ screen_view yields TWO:
   * audit.page_view + audit.scroll. Every other case yields 0 or 1.
   */
  private resolveNamesBuiltin(
    eventType: string,
    p: Record<string, unknown>,
  ): TwentyTimelineName[] {
    if (eventType === 'screen_view') {
      const path = String(p.path ?? '');
      if (path.startsWith('/audit/')) {
        const names: TwentyTimelineName[] = ['audit.page_view'];
        const scroll = this.coerceNumber(
          (p as { max_scroll?: unknown }).max_scroll ?? p.scroll,
        );
        if (scroll !== null && scroll >= AUDIT_SCROLL_THRESHOLD) {
          names.push('audit.scroll');
        }
        return names;
      }
      return [];
    }

    if (eventType === 'goal') {
      const goal = String(p.goal_name ?? '');
      if (AUDIT_VIEW_GOALS.has(goal)) return ['audit.page_view'];
      if (AUDIT_SCROLL_GOALS.has(goal)) {
        const depth = this.coerceNumber(
          (p.properties as Record<string, unknown> | undefined)?.depth,
        );
        return depth !== null && depth >= AUDIT_SCROLL_THRESHOLD
          ? ['audit.scroll']
          : [];
      }
      if (CTA_GOALS.has(goal)) return ['audit.cta_click'];
      if (RDV_GOALS.has(goal)) return ['audit.rdv'];
      if (SIGNUP_GOALS.has(goal)) return ['signup'];
      if (APP_STARTED_GOALS.has(goal)) {
        const app = String(
          (p.properties as Record<string, unknown> | undefined)?.app ?? '',
        );
        return APP_STARTED_TIMELINE_APPS.has(app) ? ['app.started'] : [];
      }
      return [];
    }

    return [];
  }

  // ─── Identity resolution (configurable, §4a/§4c.1 + N4) ──────────────────

  /**
   * Resolve the identity used to find the Person, honoring the workspace's
   * `identity_resolver`:
   *   - undefined / 'auto' : '@' → email (lowercased), else slug (verbatim).
   *   - 'email'            : always an email (lowercased + trimmed).
   *   - 'field'            : opaque id (e.g. Supabase UUID) resolved on a custom
   *                          Twenty field (`identity_field`). Passed verbatim.
   */
  resolveIdentity(
    userId: unknown,
    config?: WorkspaceCrmMapping,
  ): { identity: string | null; identityKind: IdentityKind; identityField?: string } {
    if (typeof userId !== 'string') {
      return { identity: null, identityKind: 'slug' };
    }
    const trimmed = userId.trim();
    if (!trimmed) return { identity: null, identityKind: 'slug' };

    const resolver = config?.identity_resolver ?? 'auto';

    if (resolver === 'field') {
      const field = config?.identity_field?.trim();
      if (!field) {
        // Misconfigured: 'field' without a field name → cannot resolve.
        return { identity: null, identityKind: 'field' };
      }
      return { identity: trimmed, identityKind: 'field', identityField: field };
    }

    if (resolver === 'email') {
      return { identity: trimmed.toLowerCase(), identityKind: 'email' };
    }

    // 'auto'
    return trimmed.includes('@')
      ? { identity: trimmed.toLowerCase(), identityKind: 'email' }
      : { identity: trimmed, identityKind: 'slug' };
  }

  /**
   * Legacy single-string identity normalizer (kept for the existing unit tests
   * and any caller that only needs the string form of the 'auto' resolver).
   */
  normalizeIdentity(userId: unknown): string | null {
    return this.resolveIdentity(userId).identity;
  }

  // ─── S4 — normalized acquisition source ─────────────────────────────────

  /**
   * Compute the normalized acquisition source pushed to the CRM (S4), with a
   * strict priority order so web and phone signals stay consistent:
   *   gclid/gbraid/wbraid → 'google_ads'
   *   phone_call source=ads → 'google_ads'
   *   referrer = a search engine (no click id) → 'organic_seo'
   *   utm_medium = cpc/ppc/paid → 'paid_other'
   *   utm_medium = email OR phone source=email → 'email'
   *   social referrer/medium OR phone source=social → 'social'
   *   phone source=seo → 'organic_seo' ; phone source=direct → 'direct'
   *   referrer present → 'referral'
   *   else → 'direct'
   * Returns '' when no signal is usable (caller omits the property).
   */
  acquisitionSource(p: Record<string, unknown>): string {
    const utm = (p.utm ?? {}) as Record<string, unknown>;
    const idFrom = String(utm.id_from ?? '').toLowerCase();
    const medium = String(utm.medium ?? '').toLowerCase();
    const props = (p.properties ?? {}) as Record<string, unknown>;
    const phoneSource = String(props.source ?? '').toLowerCase();
    const referrerDomain = String(p.referrer_domain ?? '').toLowerCase();

    if (idFrom === 'gclid' || idFrom === 'gbraid' || idFrom === 'wbraid') {
      return 'google_ads';
    }
    if (phoneSource === 'ads') return 'google_ads';
    if (referrerDomain && this.isSearchEngine(referrerDomain)) {
      return 'organic_seo';
    }
    if (medium === 'cpc' || medium === 'ppc' || medium === 'paid') {
      return 'paid_other';
    }
    if (medium === 'email' || phoneSource === 'email') return 'email';
    if (
      phoneSource === 'social' ||
      this.isSocial(referrerDomain) ||
      medium === 'social'
    ) {
      return 'social';
    }
    if (phoneSource === 'seo') return 'organic_seo';
    if (phoneSource === 'direct') return 'direct';
    if (referrerDomain) return 'referral';
    if (phoneSource && phoneSource !== 'other') return phoneSource;
    return 'direct';
  }

  private isSearchEngine(domain: string): boolean {
    return /(^|\.)(google|bing|yahoo|duckduckgo|ecosia|qwant|yandex|baidu)\./.test(
      domain + '.',
    );
  }

  private isSocial(domain: string): boolean {
    return /(^|\.)(facebook|instagram|linkedin|twitter|x|t|tiktok|youtube|pinterest|reddit|snapchat)\.(com|co|fr)$/.test(
      domain,
    );
  }

  /**
   * happensAt §4c.2 — the TRUE event time, ISO UTC, milliseconds max.
   * Twenty rejects micro-precision timestamps with a 400 that would fail the
   * whole batch of 60, so we always normalize through Date#toISOString().
   * Falls back to now() only when no usable timestamp is present.
   */
  private resolveHappensAt(p: Record<string, unknown>): string {
    const candidates = [
      (p as { goal_timestamp?: unknown }).goal_timestamp,
      (p as { event_timestamp?: unknown }).event_timestamp,
      (p as { entered_at?: unknown }).entered_at,
      (p as { received_at?: unknown }).received_at,
    ];
    for (const c of candidates) {
      const iso = this.toIsoOrNull(c);
      if (iso) return iso;
    }
    return new Date().toISOString();
  }

  private buildProperties(
    event: TrackedEventContext,
    p: Record<string, unknown>,
  ): Record<string, unknown> {
    const props: Record<string, unknown> = {
      // Audit trail §4.3 — duplicates detectable, replay verifiable.
      eventId: event.event_id,
      source: 'analytics',
    };
    if (p.path) props.url = p.path;
    if (p.goal_name) props.goalName = p.goal_name;
    const utm = p.utm as Record<string, unknown> | undefined;
    if (utm?.source) props.utmSource = utm.source;
    if (utm?.campaign) props.utmCampaign = utm.campaign;
    // S4 — normalized acquisition source + phone source on every milestone.
    const acq = this.acquisitionSource(p);
    if (acq) props.acquisitionSource = acq;
    const phoneSource = (p.properties as Record<string, unknown> | undefined)
      ?.source;
    if (
      String(p.goal_name ?? '') === 'phone_call' &&
      typeof phoneSource === 'string' &&
      phoneSource
    ) {
      props.phoneSource = phoneSource;
    }
    return props;
  }

  /** Accept ClickHouse "YYYY-MM-DD HH:MM:SS.SSS", ISO, or epoch ms/number. */
  private toIsoOrNull(value: unknown): string | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? null : d.toISOString();
    }
    const s = String(value);
    const normalized = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  private coerceNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }
}
