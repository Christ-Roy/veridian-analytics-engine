import { Injectable } from '@nestjs/common';

/**
 * TwentyEventMapper — pure mapping of a tracked analytics event onto a Twenty
 * timeline activity name + the identity used to resolve the target Person.
 *
 * The QUOI is frozen by CONTRATS-TUNNEL §4c.3 ("namespace.verbe", digests only,
 * never the raw goal stream) and §4a ("the bridge alone maps raw goal names →
 * timeline names; the site never knows Twenty's names, Twenty never knows the
 * site's goal names"). This class is the engine-native re-implementation of the
 * mapping that lived in the micro-service `bridge/src/analytics-pull.ts`.
 *
 * Stateless, no I/O — safe to unit-test in isolation.
 *
 * Input shape = the `event.tracked` payload emitted by
 * `events/session-payload.handler.ts#emitTracked`:
 *   { workspace_id, event_type, event_id, payload: {
 *       path, goal_name, goal_value, properties, user_id, utm, … } }
 */

/** Twenty timeline activity names — frozen §4c.3 (analytics namespace). */
export type TwentyTimelineName =
  | 'audit.page_view'
  | 'audit.scroll'
  | 'audit.cta_click'
  | 'audit.rdv'
  | 'signup'
  | 'app.started'
  | 'score.threshold';

/**
 * Raw goal names emitted by the site (terrain site-audit 2026-06-10). The
 * mapping to §4c.3 timeline names happens HERE — the site keeps its own names.
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

/** Hub goals (contrat §4a-bis). */
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
  /** Frozen timeline name §4c.3 (the activity `name`). */
  name: TwentyTimelineName;
  /**
   * Identity used to resolve the Person §4c.1:
   *   - an email (contains '@') → emails.primaryEmail
   *   - otherwise an audit slug → auditSlug
   * Comes from the event's user_id (identify(slug) then identify(email), §4a).
   */
  identity: string;
  /** True heure de l'event ISO UTC §4c.2 — jamais l'heure d'écriture. */
  happensAt: string;
  /** Stable id of the underlying tracked event — used for delivery dedup. */
  eventId: string;
  /** Extra timeline properties (audit trail §4.3). */
  properties: Record<string, unknown>;
}

@Injectable()
export class TwentyEventMapper {
  /**
   * Map a tracked event to ALL the timeline milestones it produces (0, 1 or 2).
   *
   * Most events produce NONE (raw stream noise, unknown goal, no identity).
   * A single event can produce TWO milestones: a deep /audit/ screen_view emits
   * BOTH `audit.page_view` AND `audit.scroll` — mirroring the reference
   * analytics-pull.ts (setMilestone page_view + setMilestone scroll). The
   * connector derives each milestone's deterministic id from
   * (personId, eventId, name) after resolving the Person (task #13).
   */
  mapAll(event: TrackedEventContext): MappedTimelineEvent[] {
    const p = event.payload ?? {};
    const identity = this.normalizeIdentity(p.user_id);
    if (!identity) return []; // no identity → no Person to attach to

    const names = this.resolveNames(event.event_type, p);
    if (names.length === 0) return [];

    const happensAt = this.resolveHappensAt(p);
    const properties = this.buildProperties(event, p);
    return names.map((name) => ({
      name,
      identity,
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
  map(event: TrackedEventContext): MappedTimelineEvent | null {
    return this.mapAll(event)[0] ?? null;
  }

  /**
   * Resolve ALL timeline names a raw event produces. A deep /audit/ screen_view
   * yields TWO: audit.page_view + audit.scroll (mirrors analytics-pull.ts which
   * sets both milestones). Every other case yields 0 or 1.
   */
  private resolveNames(
    eventType: string,
    p: Record<string, unknown>,
  ): TwentyTimelineName[] {
    if (eventType === 'screen_view') {
      const path = String(p.path ?? '');
      if (path.startsWith('/audit/')) {
        // An /audit/ view ALWAYS produces page_view; a deep one (scroll >= bar)
        // ALSO produces scroll. We must not drop page_view on deep views — the
        // reference emits both.
        const names: TwentyTimelineName[] = ['audit.page_view'];
        const scroll = this.coerceNumber(
          (p as { max_scroll?: unknown }).max_scroll ?? p.scroll,
        );
        if (scroll !== null && scroll >= AUDIT_SCROLL_THRESHOLD) {
          names.push('audit.scroll');
        }
        return names;
      }
      // Non-audit page views are not timeline milestones (§4c.3).
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
      // Unknown goal → not a timeline milestone.
      return [];
    }

    return [];
  }

  /**
   * Identity normalization §4a/§4c.1. Emails are lowercased + trimmed so the
   * union slug↔email and the Person lookup are stable. A slug is passed
   * through verbatim (the secret-derived suffix is case-sensitive).
   */
  normalizeIdentity(userId: unknown): string | null {
    if (typeof userId !== 'string') return null;
    const trimmed = userId.trim();
    if (!trimmed) return null;
    return trimmed.includes('@') ? trimmed.toLowerCase() : trimmed;
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
